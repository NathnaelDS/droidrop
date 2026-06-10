'use strict';

const $ = (sel) => document.querySelector(sel);

const state = {
  serial: null,
  deviceState: null,
  path: '/sdcard',
};

// ---------- device polling ----------

async function pollDevices() {
  try {
    const { devices } = await api('/api/devices');
    const best = devices.find((d) => d.state === 'device') || devices[0] || null;
    const changed = best?.serial !== state.serial || best?.state !== state.deviceState;
    state.serial = best?.serial ?? null;
    state.deviceState = best?.state ?? null;
    renderDevice(best, devices);
    if (changed && best?.state === 'device') loadDir(state.path);
    if (!best) renderList([]);
    $('#empty-state').hidden = !!best;
  } catch {
    renderDevice(null, []);
  }
}

function renderDevice(best, devices) {
  const dot = $('#device-status .dot');
  const label = $('#device-label');
  if (!best) {
    dot.className = 'dot offline';
    label.textContent = 'no device — plug in USB or use Wifi setup';
    return;
  }
  if (best.state === 'unauthorized' || best.state === 'authorizing') {
    dot.className = 'dot unauthorized';
    label.textContent = `${best.model || best.serial} — check the phone and tap “Allow USB debugging”`;
    return;
  }
  dot.className = best.state === 'device' ? 'dot online' : 'dot offline';
  const extras = devices.length > 1 ? ` (+${devices.length - 1} more link)` : '';
  label.innerHTML = '';
  label.append(
    `${best.model || best.serial}${extras} `,
    Object.assign(document.createElement('span'), { className: 'badge', textContent: best.transport }),
  );
}

// ---------- file browser ----------

async function api(url, opts) {
  const res = await fetch(url, opts);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n >= 10 ? 0 : 1)} ${units[i]}`;
}

async function loadDir(p) {
  if (!state.serial) return;
  try {
    const { entries } = await api(`/api/ls?serial=${enc(state.serial)}&path=${enc(p)}`);
    state.path = p;
    renderBreadcrumb();
    renderList(entries);
  } catch (err) {
    alert(`Could not open ${p}: ${err.message}`);
  }
}

const enc = encodeURIComponent;

function renderBreadcrumb() {
  const nav = $('#breadcrumb');
  nav.innerHTML = '';
  const parts = state.path.split('/').filter(Boolean);
  const root = document.createElement('a');
  root.textContent = '/';
  root.onclick = () => loadDir('/');
  nav.append(root);
  let acc = '';
  parts.forEach((part, i) => {
    acc += '/' + part;
    const target = acc;
    const a = document.createElement('a');
    a.textContent = part;
    a.onclick = () => loadDir(target);
    if (i > 0) nav.append(Object.assign(document.createElement('span'), { className: 'sep', textContent: '/' }));
    nav.append(a);
  });
  $('#drop-target-path').textContent = state.path;
}

function renderList(entries) {
  const ul = $('#file-list');
  ul.innerHTML = '';
  for (const e of entries) {
    const li = document.createElement('li');
    const icon = Object.assign(document.createElement('span'), {
      className: 'icon',
      textContent: e.type === 'dir' ? '📁' : '📄',
    });
    const name = Object.assign(document.createElement('span'), { className: 'name', textContent: e.name });
    const meta = Object.assign(document.createElement('span'), {
      className: 'meta',
      textContent: e.type === 'dir' ? e.mtime : `${fmtSize(e.size)} · ${e.mtime}`,
    });
    li.append(icon, name, meta);
    li.onclick = () => {
      const full = (state.path === '/' ? '' : state.path) + '/' + e.name;
      if (e.type === 'dir') loadDir(full);
      else window.location.href = `/api/pull?serial=${enc(state.serial)}&path=${enc(full)}`;
    };
    if (e.type === 'dir') {
      li.oncontextmenu = (ev) => {
        ev.preventDefault();
        const full = (state.path === '/' ? '' : state.path) + '/' + e.name;
        if (confirm(`Download "${e.name}" as a zip?`)) {
          window.location.href = `/api/pull?serial=${enc(state.serial)}&path=${enc(full)}`;
        }
      };
      li.title = 'Click to open · right-click to download as zip';
    }
    ul.append(li);
  }
}

$('#up-btn').onclick = () => {
  const parent = state.path.replace(/\/[^/]+\/?$/, '') || '/';
  loadDir(parent);
};
$('#refresh-btn').onclick = () => loadDir(state.path);
$('#newfolder-btn').onclick = async () => {
  const name = prompt('New folder name:');
  if (!name) return;
  await api('/api/mkdir', {
    method: 'POST',
    body: JSON.stringify({ serial: state.serial, path: state.path + '/' + name }),
  });
  loadDir(state.path);
};

// ---------- drag & drop upload ----------

let dragDepth = 0;
document.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  document.body.classList.add('dragging');
});
document.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); }
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  if (!state.serial) return alert('No device connected.');
  const files = await collectDropped(e.dataTransfer);
  enqueueUploads(files, state.path);
});

// Resolve dropped items (including folders) into [{file, relpath}].
async function collectDropped(dt) {
  const out = [];
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) {
    for (const f of dt.files) out.push({ file: f, relpath: f.name });
    return out;
  }
  async function walk(entry, prefix) {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, relpath: prefix + entry.name });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const child of batch) await walk(child, prefix + entry.name + '/');
      } while (batch.length);
    }
  }
  for (const entry of entries) await walk(entry, '');
  return out;
}

// ---------- transfer queue ----------

const queue = [];
let active = 0;
const MAX_CONCURRENT = 3;

function enqueueUploads(items, targetDir) {
  if (!items.length) return;
  $('#queue').hidden = false;
  for (const { file, relpath } of items) {
    const li = document.createElement('li');
    const name = Object.assign(document.createElement('span'), { className: 'qname', textContent: relpath, title: relpath });
    const bar = document.createElement('progress');
    bar.max = 1; bar.value = 0;
    const status = Object.assign(document.createElement('span'), { className: 'qstatus', textContent: 'queued' });
    li.append(name, bar, status);
    $('#queue-list').prepend(li);
    queue.push({ file, relpath, targetDir, bar, status });
  }
  pump();
}

function pump() {
  while (active < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    active++;
    uploadOne(job).finally(() => { active--; pump(); });
  }
  if (!active && !queue.length) loadDir(state.path);
}

function uploadOne({ file, relpath, targetDir, bar, status }) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/push?serial=${enc(state.serial)}&dir=${enc(targetDir)}&relpath=${enc(relpath)}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) bar.value = e.loaded / e.total;
      status.textContent = 'uploading';
    };
    xhr.onload = () => {
      if (xhr.status === 200) {
        bar.value = 1;
        status.textContent = 'done';
        status.className = 'qstatus done';
      } else {
        let msg = 'failed';
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
        status.textContent = msg;
        status.className = 'qstatus error';
      }
      resolve();
    };
    xhr.onerror = () => {
      status.textContent = 'network error';
      status.className = 'qstatus error';
      resolve();
    };
    status.textContent = 'sending to phone…';
    xhr.send(file);
  });
}

// ---------- wifi setup ----------

const dialog = $('#wifi-dialog');
$('#wifi-btn').onclick = () => { dialog.showModal(); scanMdns(); };
$('#wifi-close').onclick = () => dialog.close();

function wifiResult(msg, ok) {
  const el = $('#wifi-result');
  el.textContent = msg;
  el.style.color = ok ? 'var(--accent)' : 'var(--danger)';
}

$('#wifi-via-usb-btn').onclick = async () => {
  const usb = state.serial && !state.serial.includes(':') ? state.serial : null;
  if (!usb) return wifiResult('No USB device connected — plug in the cable first.', false);
  wifiResult('Switching the phone to wifi mode…', true);
  const r = await api('/api/wifi-via-usb', { method: 'POST', body: JSON.stringify({ serial: usb }) });
  wifiResult(r.message, r.ok);
  if (r.ok) pollDevices();
};

$('#pair-btn').onclick = async () => {
  const address = $('#pair-address').value.trim();
  const code = $('#pair-code').value.trim();
  if (!address || !code) return wifiResult('Enter the pairing IP:port and code.', false);
  wifiResult('Pairing…', true);
  const r = await api('/api/pair', { method: 'POST', body: JSON.stringify({ address, code }) });
  wifiResult(r.message, r.ok);
  if (r.ok) scanMdns();
};

$('#connect-btn').onclick = async () => {
  const address = $('#connect-address').value.trim();
  if (!address) return wifiResult('Enter the connect IP:port.', false);
  wifiResult('Connecting…', true);
  const r = await api('/api/connect', { method: 'POST', body: JSON.stringify({ address }) });
  wifiResult(r.message, r.ok);
  if (r.ok) pollDevices();
};

$('#scan-btn').onclick = () => scanMdns();

async function scanMdns() {
  const ul = $('#mdns-list');
  ul.innerHTML = '<li class="muted">scanning…</li>';
  try {
    const { services } = await api('/api/mdns');
    const connectable = services.filter((s) => s.type.startsWith('_adb-tls-connect'));
    ul.innerHTML = '';
    if (!connectable.length) {
      ul.innerHTML = '<li class="muted">No phones advertising wireless debugging found.</li>';
      return;
    }
    for (const s of connectable) {
      const li = document.createElement('li');
      const addr = Object.assign(document.createElement('span'), { className: 'addr', textContent: s.address });
      const btn = Object.assign(document.createElement('button'), { textContent: 'Connect' });
      btn.onclick = async () => {
        wifiResult('Connecting…', true);
        const r = await api('/api/connect', { method: 'POST', body: JSON.stringify({ address: s.address }) });
        wifiResult(r.message, r.ok);
        if (r.ok) pollDevices();
      };
      li.append(addr, btn);
      ul.append(li);
    }
  } catch (err) {
    ul.innerHTML = `<li class="muted">scan failed: ${err.message}</li>`;
  }
}

// ---------- boot ----------

pollDevices();
setInterval(pollDevices, 3000);
