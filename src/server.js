import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as adb from './adb.js';

const PORT = Number(process.env.PORT || 7878);
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(data);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) reject(new Error('body too large'));
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Keep uploaded relative paths confined to a temp dir and to the target dir on the phone.
function safeRelPath(rel) {
  const cleaned = path.posix.normalize(String(rel)).replace(/^\/+/, '');
  if (cleaned === '..' || cleaned.startsWith('../') || cleaned.includes('\0')) {
    throw new Error('invalid relative path');
  }
  return cleaned;
}

async function handlePush(req, res, q) {
  const serial = q.get('serial');
  const dir = q.get('dir');
  const rel = safeRelPath(q.get('relpath') || q.get('name'));
  if (!serial || !dir || !rel) return json(res, 400, { error: 'serial, dir and relpath required' });

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'droidrop-'));
  const tmpFile = path.join(tmpDir, path.basename(rel));
  try {
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmpFile);
      req.pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
      req.on('error', reject);
    });

    const remotePath = path.posix.join(dir, rel);
    await adb.mkdirp(serial, path.posix.dirname(remotePath));
    const result = await adb.push(serial, tmpFile, remotePath);
    if (!result.ok) {
      return json(res, 502, { error: (result.stderr || result.stdout || 'adb push failed').trim() });
    }
    json(res, 200, { ok: true, remotePath });
  } catch (err) {
    json(res, 500, { error: err.message });
  } finally {
    fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function handlePull(req, res, q) {
  const serial = q.get('serial');
  const remotePath = q.get('path');
  if (!serial || !remotePath) return json(res, 400, { error: 'serial and path required' });

  const st = await adb.stat(serial, remotePath);
  if (!st) return json(res, 404, { error: 'not found on device' });
  const baseName = path.posix.basename(remotePath) || 'file';

  if (st.type === 'file') {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': st.size,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(baseName)}`,
    });
    const child = adb.pullStream(serial, remotePath);
    child.stdout.pipe(res);
    child.on('error', () => res.destroy());
    res.on('close', () => child.kill());
    return;
  }

  // Directory: pull to a temp dir, stream it back as a zip.
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'droidrop-'));
  try {
    const result = await adb.pull(serial, remotePath, tmpDir);
    if (!result.ok) return json(res, 502, { error: (result.stderr || 'adb pull failed').trim() });
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(baseName)}.zip`,
    });
    const zip = spawn('zip', ['-q', '-r', '-', baseName], { cwd: tmpDir });
    zip.stdout.pipe(res);
    await new Promise((resolve) => zip.on('close', resolve));
  } catch (err) {
    if (!res.headersSent) json(res, 500, { error: err.message });
    else res.destroy();
  } finally {
    fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const q = url.searchParams;

  try {
    if (url.pathname === '/api/devices' && req.method === 'GET') {
      return json(res, 200, { devices: await adb.listDevices() });
    }
    if (url.pathname === '/api/ls' && req.method === 'GET') {
      const serial = q.get('serial');
      const p = q.get('path') || '/sdcard';
      if (!serial) return json(res, 400, { error: 'serial required' });
      return json(res, 200, { path: p, entries: await adb.ls(serial, p) });
    }
    if (url.pathname === '/api/push' && req.method === 'PUT') {
      return await handlePush(req, res, q);
    }
    if (url.pathname === '/api/pull' && req.method === 'GET') {
      return await handlePull(req, res, q);
    }
    if (url.pathname === '/api/mkdir' && req.method === 'POST') {
      const { serial, path: p } = JSON.parse(await readBody(req));
      await adb.mkdirp(serial, p);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/pair' && req.method === 'POST') {
      const { address, code } = JSON.parse(await readBody(req));
      return json(res, 200, await adb.pair(address, code));
    }
    if (url.pathname === '/api/connect' && req.method === 'POST') {
      const { address } = JSON.parse(await readBody(req));
      return json(res, 200, await adb.connect(address));
    }
    if (url.pathname === '/api/wifi-via-usb' && req.method === 'POST') {
      const { serial } = JSON.parse(await readBody(req));
      return json(res, 200, await adb.wifiViaUsb(serial));
    }
    if (url.pathname === '/api/mdns' && req.method === 'GET') {
      return json(res, 200, { services: await adb.mdnsServices() });
    }

    // Static files
    if (req.method === 'GET') {
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = path.join(publicDir, path.normalize(rel));
      if (file.startsWith(publicDir) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        return fs.createReadStream(file).pipe(res);
      }
    }
    json(res, 404, { error: 'not found' });
  } catch (err) {
    if (!res.headersSent) json(res, 500, { error: err.message });
    else res.destroy();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`droidrop running at http://localhost:${PORT}`);
  console.log(`adb binary: ${adb.ADB}`);
});
