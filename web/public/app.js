'use strict';

/* ═══════════════════════════════════════════════
   Xray Manager — Frontend Application
   ═══════════════════════════════════════════════ */

let token          = localStorage.getItem('token');
let currentSection = 'overview';
let users          = [];
let tunnelData     = {};
let logEntries     = [];
let serverIp       = '';
let vlessPort      = 443;

/* ──── API helper ──── */
async function api(method, url, body) {
  const opts = {
    method,
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

/* ──── Auth ──── */
async function checkAuth() {
  if (!token) return false;
  try { await api('GET', '/api/validate'); return true; }
  catch { return false; }
}
function logout() {
  localStorage.removeItem('token');
  window.location.href = '/login.html';
}

/* ──── Navigation ──── */
function showSection(name) {
  currentSection = name;
  document.querySelectorAll('.section').forEach(s =>
    s.classList.toggle('active', s.id === 'section-' + name));
  document.querySelectorAll('.nav-item').forEach(n =>
    n.classList.toggle('active', n.dataset.section === name));

  if (name === 'users')   loadUsers();
  if (name === 'tunnels') loadTunnels();
  if (name === 'logs')    loadLogs();
}

/* ──── Helpers ──── */
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d.getTime()) ? '—' : d.toISOString().slice(0, 16).replace('T', ' ');
}

function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
  return Promise.resolve();
}

/* ════════════════  OVERVIEW  ════════════════ */
function vlessUri(username, password) {
  return 'vless://' + username + '-' + password + '@' + serverIp + ':' + vlessPort + '?security=none&encryption=none&type=tcp&headerType=none#GodUser-VLESS';
}

function updateOverview(stats) {
  if (!stats || typeof stats !== 'object') return;
  if (stats.serverIp) serverIp = stats.serverIp;
  if (stats.vlessPort) vlessPort = stats.vlessPort;
  const $ = id => document.getElementById(id);

  $('stat-cpu').textContent     = (stats.cpu || '—') + '%';
  $('stat-ram').textContent     = (stats.ram || '—') + '%';
  $('stat-traffic').textContent = (stats.totalTraffic || '0.00') + ' GB';
  $('stat-users').textContent   = stats.usersCount ?? '—';

  const statusEl = $('stat-status');
  statusEl.textContent = stats.xrayStatus || '—';
  statusEl.className   = 'stat-value ' + (stats.xrayStatus === 'RUNNING' ? 'text-success' : 'text-danger');

  const routeLabel = {
    'tun0-out':       'TUN0 (Primary)',
    'socks-balancer': 'SOCKS Balancer'
  };
  $('stat-route').textContent = routeLabel[stats.activeOutbound] || stats.activeOutbound || '—';

  for (let i = 1; i <= 3; i++) {
    const active = stats['out' + i + 'Active'];
    const sEl = $('out' + i + '-status');
    sEl.textContent = active ? 'ACTIVE' : 'IDLE';
    sEl.className   = 'badge ' + (active ? 'badge-success' : 'badge-muted');
    $('out' + i + '-traffic').textContent = (stats['out' + i + 'GB'] || '0.00') + ' GB';
  }
}

/* ════════════════  USERS  ════════════════ */
async function loadUsers() {
  try {
    users = await api('GET', '/api/users');
    users.sort((a, b) => a.username.localeCompare(b.username));
    renderUsers();
  }
  catch (e) { console.error('loadUsers', e); }
}

function renderUsers() {
  const tbody = document.getElementById('users-tbody');
  if (!tbody) return;
  tbody.innerHTML = users.map(u => {
    let remDays = '—';
    if (u.expiresAt) {
      const diff = new Date(u.expiresAt).getTime() - Date.now();
      remDays = diff > 0 ? Math.ceil(diff / 86400000) : 'Expired';
    }
    const on = u.enabled !== false;
    return '<tr>' +
      '<td>' + esc(u.username) + '</td>' +
      '<td><span class="badge ' + (on ? 'badge-success' : 'badge-danger') + '">' + (on ? 'ON' : 'OFF') + '</span></td>' +
      '<td class="password-cell">' +
        '<span class="pw-mask">••••••</span>' +
        '<span class="pw-plain" style="display:none">' + esc(u.password) + '</span> ' +
        '<button class="btn-icon pw-toggle" title="Reveal">&#128065;</button>' +
      '</td>' +
      '<td>' + (u.quotaGiB === null ? '∞' : u.quotaGiB) + '</td>' +
      '<td>' + (u.usedGiB != null ? u.usedGiB.toFixed(3) : '0.000') + '</td>' +
      '<td>' + remDays + '</td>' +
      '<td>' + fmtDate(u.expiresAt) + '</td>' +
      '<td>' + fmtDate(u.lastSeenAt) + '</td>' +
      '<td class="actions">' +
        '<button class="btn btn-sm btn-outline btn-copy-vless" data-vless="' + esc(vlessUri(u.username, u.password)) + '" title="Copy VLESS link">&#128279; Link</button>' +
        '<button class="btn btn-sm btn-outline" data-action="toggle" data-user="' + esc(u.username) + '">' + (on ? 'Disable' : 'Enable') + '</button>' +
        '<button class="btn btn-sm btn-danger" data-action="delete" data-user="' + esc(u.username) + '">Delete</button>' +
      '</td>' +
    '</tr>';
  }).join('');

  /* password toggle */
  tbody.querySelectorAll('.pw-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const cell = btn.closest('.password-cell');
      const mask  = cell.querySelector('.pw-mask');
      const plain = cell.querySelector('.pw-plain');
      const hidden = plain.style.display === 'none';
      mask.style.display  = hidden ? 'none' : '';
      plain.style.display = hidden ? '' : 'none';
    });
  });

  /* vless copy buttons */
  tbody.querySelectorAll('.btn-copy-vless').forEach(btn => {
    btn.addEventListener('click', () => {
      showVlessModal(btn.dataset.vless);
    });
  });

  /* action buttons */
  tbody.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const user   = btn.dataset.user;
      const action = btn.dataset.action;
      if (action === 'toggle') toggleUser(user);
      if (action === 'delete') confirmDeleteUser(user);
    });
  });
}

async function addUser() {
  const form = document.getElementById('addUserForm');
  const username = form.username.value.trim();
  const password = form.password.value.trim();
  const quota    = form.quota.value.trim();
  const days     = form.days.value.trim();
  if (!username || !password) return alert('Username and password are required');

  let expiresAt = null;
  if (days && !isNaN(days)) expiresAt = new Date(Date.now() + Number(days) * 86400000).toISOString();

  try {
    await api('POST', '/api/users', { username, password, quotaGiB: quota || null, expiresAt });
    closeModal();
    loadUsers();
  } catch (e) { alert(e.message); }
}

async function toggleUser(username) {
  try { await api('PATCH', '/api/users/' + encodeURIComponent(username) + '/toggle'); loadUsers(); }
  catch (e) { alert(e.message); }
}

async function confirmDeleteUser(username) {
  if (!confirm('Delete user "' + username + '"?')) return;
  try { await api('DELETE', '/api/users/' + encodeURIComponent(username)); loadUsers(); }
  catch (e) { alert(e.message); }
}

/* ════════════════  TUNNELS  ════════════════ */
async function loadTunnels() {
  try { tunnelData = await api('GET', '/api/tunnels'); renderTunnels(); }
  catch (e) { console.error('loadTunnels', e); }
}

function renderTunnels() {
  const container = document.getElementById('tunnels-list');
  if (!container) return;
  const order   = tunnelData.order || [];
  const details = {};
  (tunnelData.outbounds || []).forEach(o => details[o.tag] = o);

  /* failover badge */
  const foEl = document.getElementById('failover-status');
  if (foEl) {
    const on = tunnelData.failoverEnabled !== false;
    foEl.textContent = on ? 'ON' : 'OFF';
    foEl.className   = 'badge ' + (on ? 'badge-success' : 'badge-danger');
  }

  container.innerHTML = order.map((tag, i) => {
    const d         = details[tag] || { tag, label: tag, type: 'unknown' };
    const isPrimary = tag === tunnelData.activeOutbound;
    const endpoint  = d.type === 'socks' ? (d.host + ':' + d.port) : (d.type === 'freedom' ? 'tun0 interface' : '—');

    return '<div class="tunnel-card' + (isPrimary ? ' tunnel-primary' : '') + '" data-tag="' + tag + '">' +
      '<div class="tunnel-controls">' +
        '<button class="btn-icon" data-move="' + i + ':-1"' + (i === 0 ? ' disabled' : '') + '>&#9650;</button>' +
        '<button class="btn-icon" data-move="' + i + ':1"'  + (i === order.length - 1 ? ' disabled' : '') + '>&#9660;</button>' +
      '</div>' +
      '<div class="tunnel-info">' +
        '<div class="tunnel-name">' + esc(d.label || tag) +
          (isPrimary ? ' <span class="badge badge-accent">PRIMARY</span>' : '') +
        '</div>' +
        '<div class="tunnel-meta">Type: ' + d.type + '  |  Endpoint: ' + endpoint + '</div>' +
      '</div>' +
      '<div class="tunnel-actions">' +
        (isPrimary
          ? '<span class="text-success">&#9679; Active</span>'
          : '<button class="btn btn-sm btn-outline" data-primary="' + tag + '">Set Primary</button>') +
      '</div>' +
    '</div>';
  }).join('');

  /* wire move buttons */
  container.querySelectorAll('[data-move]').forEach(btn => {
    btn.addEventListener('click', () => {
      const [idx, dir] = btn.dataset.move.split(':').map(Number);
      moveTunnel(idx, dir);
    });
  });

  /* wire set-primary buttons */
  container.querySelectorAll('[data-primary]').forEach(btn => {
    btn.addEventListener('click', () => setPrimary(btn.dataset.primary));
  });
}

function moveTunnel(index, direction) {
  const order    = [...(tunnelData.order || [])];
  const newIndex = index + direction;
  if (newIndex < 0 || newIndex >= order.length) return;
  [order[index], order[newIndex]] = [order[newIndex], order[index]];
  tunnelData.order = order;
  renderTunnels();
  saveTunnelOrder(order);
}

async function saveTunnelOrder(order) {
  try { await api('PUT', '/api/tunnels/order', { order }); }
  catch (e) { alert(e.message); }
}

async function setPrimary(tag) {
  try { await api('PUT', '/api/tunnels/primary', { outbound: tag }); loadTunnels(); }
  catch (e) { alert(e.message); }
}

async function toggleFailover() {
  try {
    const settings = await api('GET', '/api/settings');
    await api('PUT', '/api/settings', { failoverEnabled: !settings.failoverEnabled });
    loadTunnels();
  } catch (e) { alert(e.message); }
}

/* ════════════════  LOGS  ════════════════ */
async function loadLogs() {
  try { logEntries = await api('GET', '/api/logs'); renderLogs(); }
  catch (e) { console.error('loadLogs', e); }
}

function renderLogs() {
  const c = document.getElementById('logs-container');
  if (!c) return;
  c.innerHTML = logEntries.map(e =>
    '<div class="log-entry"><span class="log-time">' +
    (e.time ? e.time.slice(11, 19) : '') + '</span> ' + esc(e.msg) + '</div>'
  ).join('');
  c.scrollTop = c.scrollHeight;
}

function appendLog(entry) {
  logEntries.push(entry);
  if (logEntries.length > 500) logEntries.shift();
  if (currentSection === 'logs') {
    const c = document.getElementById('logs-container');
    if (!c) return;
    const div       = document.createElement('div');
    div.className   = 'log-entry';
    div.innerHTML   = '<span class="log-time">' + (entry.time ? entry.time.slice(11, 19) : '') + '</span> ' + esc(entry.msg);
    c.appendChild(div);
    c.scrollTop = c.scrollHeight;
  }
}

/* ════════════════  MODAL  ════════════════ */
function openModal()  { document.getElementById('modal-overlay').style.display = 'flex'; }
function closeModal() { document.getElementById('modal-overlay').style.display = 'none'; document.getElementById('addUserForm').reset(); }

function showVlessModal(uri) {
  const ta = document.getElementById('vless-link-text');
  ta.value = uri;
  document.getElementById('vless-modal-overlay').style.display = 'flex';
  setTimeout(() => ta.select(), 50);
}
function closeVlessModal() {
  document.getElementById('vless-modal-overlay').style.display = 'none';
}

/* ════════════════  BULK CREATE  ════════════════ */
function openBulkModal() {
  document.getElementById('bulk-result').style.display = 'none';
  document.getElementById('bulkForm').style.display = '';
  document.getElementById('bulk-submit-btn').disabled = false;
  document.getElementById('bulk-modal-overlay').style.display = 'flex';
}
function closeBulkModal() {
  document.getElementById('bulk-modal-overlay').style.display = 'none';
  document.getElementById('bulkForm').reset();
  document.getElementById('bulk-result').style.display = 'none';
}

function generatePassword(len) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let pw = '';
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  for (let i = 0; i < len; i++) pw += chars[arr[i] % chars.length];
  return pw;
}

async function bulkCreate() {
  const form  = document.getElementById('bulkForm');
  const prefix = form.prefix.value.trim();
  const quota  = form.quota.value.trim();
  const days   = form.days.value.trim();
  const count  = parseInt(form.count.value, 10);
  if (!prefix || !count || count < 1) return alert('Prefix and count are required');

  const btn = document.getElementById('bulk-submit-btn');
  btn.disabled = true;
  btn.textContent = 'Creating...';

  let expiresAt = null;
  if (days && !isNaN(days)) expiresAt = new Date(Date.now() + Number(days) * 86400000).toISOString();

  const created = [];
  const errors  = [];

  for (let i = 0; i < count; i++) {
    const suffix   = Math.floor(10000 + Math.random() * 90000).toString();
    const username = prefix + suffix;
    const password = generatePassword(8);
    try {
      await api('POST', '/api/users', { username, password, quotaGiB: quota || null, expiresAt });
      created.push({ username, password });
    } catch (e) {
      errors.push(username + ': ' + e.message);
    }
  }

  // Show results
  const lines = created.map(u => u.username + '  |  ' + u.password + '  |  ' + vlessUri(u.username, u.password)).join('\n');
  const header = 'Username  |  Password  |  VLESS URI\n' + '-'.repeat(60) + '\n';
  document.getElementById('bulk-result-text').value = header + lines + (errors.length ? '\n\nErrors:\n' + errors.join('\n') : '');
  document.getElementById('bulk-result').style.display = '';
  form.style.display = 'none';
  btn.disabled = false;
  btn.textContent = 'Create';

  loadUsers();
}

function copyBulkResult() {
  const text = document.getElementById('bulk-result-text').value;
  copyText(text).then(() => {
    const btn = document.querySelector('#bulk-result .btn-accent');
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy All'; }, 1500);
  });
}

/* ════════════════  SSE  ════════════════ */
function connectSSE() {
  if (!token) return;
  const es = new EventSource('/api/events?token=' + token);

  es.addEventListener('stats', e => {
    try { updateOverview(JSON.parse(e.data)); } catch {}
  });

  es.addEventListener('log', e => {
    try { appendLog(JSON.parse(e.data)); } catch {}
  });

  es.addEventListener('users', e => {
    try {
      users = JSON.parse(e.data);
      users.sort((a, b) => a.username.localeCompare(b.username));
      if (currentSection === 'users') renderUsers();
    } catch {}
  });

  es.onerror = () => { es.close(); setTimeout(connectSSE, 5000); };
}

/* ════════════════  INIT  ════════════════ */
async function init() {
  if (!(await checkAuth())) return;

  /* navigation */
  document.querySelectorAll('.nav-item').forEach(n =>
    n.addEventListener('click', () => showSection(n.dataset.section)));
  document.getElementById('btn-logout').addEventListener('click', logout);

  /* initial data */
  showSection('overview');
  try { updateOverview(await api('GET', '/api/status')); } catch {}
  loadUsers();

  /* live stream */
  connectSSE();
}

init();
