import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendored = path.join(projectRoot, 'vendor', 'platform-tools', 'adb');

export const ADB = fs.existsSync(vendored) ? vendored : 'adb';

// Quote a string for the Android-side /bin/sh (used inside `adb shell`).
export function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function run(args, { timeout = 30_000 } = {}) {
  return new Promise((resolve) => {
    execFile(ADB, args, { timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err?.code ?? 0, stdout: stdout ?? '', stderr: stderr ?? '', error: err?.message });
    });
  });
}

export async function listDevices() {
  const { stdout } = await run(['devices', '-l']);
  const devices = [];
  for (const line of stdout.split('\n').slice(1)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(\S+)\s+(device|offline|unauthorized|authorizing|recovery|sideload)\s*(.*)$/);
    if (!m) continue;
    const [, serial, state, rest] = m;
    const props = {};
    for (const kv of rest.split(/\s+/)) {
      const i = kv.indexOf(':');
      if (i > 0) props[kv.slice(0, i)] = kv.slice(i + 1);
    }
    const wifi = serial.includes(':') || serial.includes('_adb-tls-connect');
    devices.push({
      serial,
      state,
      transport: wifi ? 'wifi' : 'usb',
      model: (props.model ?? '').replace(/_/g, ' '),
      device: props.device ?? '',
    });
  }
  // Prefer USB entries first so the UI's default pick is the fastest link.
  devices.sort((a, b) => (a.transport === 'usb' ? -1 : 1) - (b.transport === 'usb' ? -1 : 1));
  return devices;
}

// `adb exec-out` gives 8-bit-clean output (no pty mangling).
export function execOut(serial, shellCmd, opts) {
  return run(['-s', serial, 'exec-out', shellCmd], opts);
}

// stat (unlike ls) prints names raw — no backslash-escaping of spaces to undo.
const STAT_LINE = /^([^|]+)\|(\d+)\|(\d+)\|(.*)$/;

function fmtEpoch(epoch) {
  const d = new Date(epoch * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export async function ls(serial, dirPath) {
  const script =
    `cd ${shq(dirPath)} 2>/dev/null || { echo '!!NOACCESS'; exit 0; }; ` +
    `stat -c '%F|%s|%Y|%n' -- .* * 2>/dev/null; exit 0`;
  const res = await execOut(serial, script);
  if (res.stdout.startsWith('!!NOACCESS')) {
    throw new Error(`cannot open ${dirPath}`);
  }
  const entries = [];
  for (const line of res.stdout.split('\n')) {
    const m = line.match(STAT_LINE);
    if (!m) continue;
    const [, ftype, size, epoch, name] = m;
    if (name === '.' || name === '..') continue;
    let type = ftype.includes('directory') ? 'dir' : ftype.includes('symbolic') ? 'link' : 'file';
    // Treat symlinks to directories as dirs so they're navigable.
    if (type === 'link') {
      const probe = await execOut(serial, `[ -d ${shq(path.posix.join(dirPath, name))} ] && echo d || echo f`);
      type = probe.stdout.trim() === 'd' ? 'dir' : 'file';
    }
    entries.push({ name, type, size: Number(size), mtime: fmtEpoch(Number(epoch)) });
  }
  entries.sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name));
  return entries;
}

export async function stat(serial, remotePath) {
  const res = await execOut(serial, `stat -c '%F|%s' ${shq(remotePath)}`);
  if (!res.stdout.includes('|')) return null;
  const [ftype, size] = res.stdout.trim().split('|');
  return { type: ftype.includes('directory') ? 'dir' : 'file', size: Number(size) };
}

export async function mkdirp(serial, remotePath) {
  const res = await execOut(serial, `mkdir -p ${shq(remotePath)}`);
  if (!res.ok) throw new Error(res.stderr.trim() || 'mkdir failed');
}

export function push(serial, localPath, remotePath) {
  return run(['-s', serial, 'push', localPath, remotePath], { timeout: 0 });
}

// Stream a remote file's bytes without an intermediate temp copy.
export function pullStream(serial, remotePath) {
  return spawn(ADB, ['-s', serial, 'exec-out', `cat ${shq(remotePath)}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function pull(serial, remotePath, localPath) {
  return run(['-s', serial, 'pull', remotePath, localPath], { timeout: 0 });
}

export async function pair(hostPort, code) {
  const res = await run(['pair', hostPort, code], { timeout: 20_000 });
  const out = (res.stdout + res.stderr).trim();
  return { ok: /successfully paired/i.test(out), message: out };
}

export async function connect(hostPort) {
  const res = await run(['connect', hostPort], { timeout: 15_000 });
  const out = (res.stdout + res.stderr).trim();
  return { ok: /connected/i.test(out) && !/cannot|failed|unable/i.test(out), message: out };
}

// With a USB cable attached, switch the phone's adbd to TCP mode and connect to
// it over wifi — no pairing codes needed. Classic `adb tcpip` flow.
export async function wifiViaUsb(serial) {
  const ipRes = await execOut(serial, `ip route get 1 2>/dev/null || ip route`);
  const ip = ipRes.stdout.match(/\bsrc\s+(\d+\.\d+\.\d+\.\d+)/)?.[1];
  if (!ip) {
    return { ok: false, message: 'Could not find the phone’s wifi IP — is its wifi on?' };
  }
  const tcp = await run(['-s', serial, 'tcpip', '5555'], { timeout: 15_000 });
  if (!tcp.ok) {
    return { ok: false, message: (tcp.stderr || tcp.stdout || 'adb tcpip failed').trim() };
  }
  // adbd restarts in TCP mode; give it a moment before connecting.
  await new Promise((r) => setTimeout(r, 1500));
  const conn = await connect(`${ip}:5555`);
  return { ok: conn.ok, message: conn.ok ? `Connected over wifi at ${ip}:5555 — you can unplug the cable.` : conn.message };
}

// Phones with Wireless debugging on advertise _adb-tls-connect via mDNS.
export async function mdnsServices() {
  const res = await run(['mdns', 'services'], { timeout: 10_000 });
  const services = [];
  for (const line of res.stdout.split('\n')) {
    const m = line.trim().match(/^(\S+)\s+(_adb\S*\._tcp\.?)\s+(\S+:\d+)$/);
    if (m) services.push({ name: m[1], type: m[2], address: m[3] });
  }
  return services;
}
