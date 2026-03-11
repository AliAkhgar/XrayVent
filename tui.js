'use strict';

const blessed = require('blessed');
const contrib = require('blessed-contrib');

function fmtDate(s) {
  if (!s) return '-';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

function fmtNum(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '-';
  return Number(n).toFixed(digits);
}

function createTui(handlers) {
  const screen = blessed.screen({ smartCSR: true, title: handlers.title || 'Dashboard' });
  const grid = new contrib.grid({ rows: 12, cols: 12, screen });

  grid.set(0, 0, 1, 12, blessed.box, {
    content: ' [ GodUser Manager ]  Keys: (q) Quit | (a) Add User | (d) Delete User | (t) Toggle Active ',
    style: { fg: 'black', bg: 'cyan', bold: true }, align: 'center'
  });

  // پنل مانیتورینگ سیستم و وضعیت مسیرها
  const sysBox = grid.set(1, 0, 5, 5, blessed.box, {
    label: ' System & Routing Monitor ', style: { border: { fg: 'green' } }, border: 'line', tags: true,
    content: '{yellow-fg}Loading data...{/yellow-fg}'
  });

  // پنل کنترل و تنظیمات
  const controlForm = grid.set(1, 5, 5, 7, blessed.form, {
    label: ' Controls & Infrastructure ', style: { border: { fg: 'magenta' } }, border: 'line', keys: true
  });

  const btnStart = blessed.button({ parent: controlForm, left: 1, top: 0, height: 1, width: 11, content: ' [ START ] ', style: { bg: 'green', fg: 'black', focus: { bg: 'white' } }, mouse: true, keys: true, name: 'start' });
  const btnStop = blessed.button({ parent: controlForm, left: 13, top: 0, height: 1, width: 10, content: ' [ STOP ] ', style: { bg: 'yellow', fg: 'black', focus: { bg: 'white' } }, mouse: true, keys: true, name: 'stop' });
  const btnKill = blessed.button({ parent: controlForm, left: 24, top: 0, height: 1, width: 14, content: ' [ KILL ALL ] ', style: { bg: 'red', fg: 'white', bold: true, focus: { bg: 'white', fg: 'black' } }, mouse: true, keys: true, name: 'kill' });

  // اطلاعات ثابت سرور بدون کاراکترهای اضافی
  blessed.text({
    parent: controlForm, top: 2, left: 1, tags: true,
    content: `{cyan-fg}Inbounds:{/cyan-fg} VLESS (${handlers.settings.vlessIn}) | SOCKS (${handlers.settings.socksIn})\n` +
             `{cyan-fg}SOCKS-1:{/cyan-fg}  ${handlers.settings.out1}\n` +
             `{cyan-fg}SOCKS-2:{/cyan-fg}  ${handlers.settings.out2}\n` +
             `{cyan-fg}SOCKS-3:{/cyan-fg}  ${handlers.settings.out3}`
  });

  btnStart.on('press', () => handlers.onStart?.()); btnStop.on('press', () => handlers.onStop?.()); btnKill.on('press', () => handlers.onKill?.());

  const table = grid.set(6, 0, 4, 12, contrib.table, {
    label: ' Users Database ', keys: true, interactive: true,
    style: { fg: 'white', bg: 'black', border: { fg: 'blue' }, header: { fg: 'cyan', bold: true }, cell: { fg: 'white', selected: { bg: 'blue' } } },
    border: { type: 'line' }, columnSpacing: 2,
    columnWidth: [12, 6, 10, 8, 8, 8, 16, 16]
  });

  const logs = grid.set(10, 0, 2, 12, contrib.log, {
    label: ' Activity Logs ', fg: 'white', selectedFg: 'white', border: { type: 'line', fg: 'grey' }
  });

  const prompt = blessed.prompt({
    parent: screen, border: 'line', height: 8, width: '60%', top: 'center', left: 'center',
    label: ' User Input ', tags: true, keys: true, hidden: true,
    style: { fg: 'white', bg: 'black', border: { fg: 'cyan' } }
  });

  let users = [];
  function log(msg) { logs.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`); screen.render(); }
  function selectedUsername() { const sel = table.rows?.selected; return sel === undefined || sel === null ? null : users[sel]?.username || null; }

  // تابع به‌روزرسانی پنل مانیتورینگ
  function setStats(stats) {
      sysBox.setContent(
        `{bold}Core:{/}   ${stats.xrayStatus === 'RUNNING' ? '{green-fg}RUNNING{/}' : '{red-fg}STOPPED{/}'}  |  Users: ${stats.usersCount}\n` +
        `{bold}Res:{/}    CPU: ${stats.cpu}%  |  RAM: ${stats.ram}%\n` +
        `{bold}Total:{/}  {cyan-fg}${stats.totalTraffic} GB{/}\n` +
        `{bold}Route:{/}  ${stats.activeOutbound === 'tun0-out' ? '{green-fg}TUN0 (Primary){/}' : '{yellow-fg}SOCKS BALANCER (Failover){/}'}\n` +
        `{grey-fg}--------------------------------------{/}\n` +
        `{bold}S1:{/} [${stats.out1StatusText}] ${stats.out1GB} GB\n` +
        `{bold}S2:{/} [${stats.out2StatusText}] ${stats.out2GB} GB\n` +
        `{bold}S3:{/} [${stats.out3StatusText}] ${stats.out3GB} GB`
      );
      screen.render();
  }

  function setUsers(nextUsers) {
    users = [...(nextUsers || [])].sort((a, b) => a.username.localeCompare(b.username));
    const data = users.map(u => {
        let remDays = '-';
        if (u.expiresAt) {
           const diff = new Date(u.expiresAt).getTime() - Date.now();
           remDays = diff > 0 ? Math.ceil(diff / 86400000).toString() : 'Exp';
        }
        return [
            u.username, u.enabled === false ? 'OFF' : 'ON', u.password,
            u.quotaGiB === null ? 'UL' : fmtNum(u.quotaGiB, 2), fmtNum(u.usedGiB ?? 0, 3),
            remDays, fmtDate(u.expiresAt), fmtDate(u.lastSeenAt)
        ];
    });
    table.setData({ headers: ['Username', 'State', 'Pass', 'Quota', 'Used', 'Rem.Days', 'Expires', 'LastSeen'], data });
    screen.render();
  }

  function ask(text) {
    return new Promise((resolve) => { prompt.show(); prompt.input(text, '', (err, value) => { prompt.hide(); screen.render(); resolve(err ? null : value); }); });
  }

  screen.key(['q', 'C-c'], () => process.exit(0)); screen.key(['a'], () => addUserFlow()); screen.key(['d'], () => deleteUserFlow()); screen.key(['t'], () => toggleUserFlow());

  async function addUserFlow() {
    const u = await ask('Username:'); if(!u) return;
    const p = await ask('Password:'); if(!p) return;
    const q = await ask('Quota GB (opt):');
    const d = await ask('Valid Days (e.g. 30, opt):');

    let ex = null;
    if (d && !isNaN(d)) ex = new Date(Date.now() + Number(d) * 86400000).toISOString();

    await handlers.onAddUser?.({ username: u, password: p, quotaGiB: q, expiresAt: ex });
  }

  async function deleteUserFlow() { const u = selectedUsername(); if (u && (await ask(`Delete ${u}? (type yes)`)) === 'yes') await handlers.onDeleteUser?.(u); }
  async function toggleUserFlow() { const u = selectedUsername(); if(u) await handlers.onToggleEnable?.(u); }

  table.focus(); screen.render();
  return { log, setUsers, setStats, screen };
}

module.exports = { createTui };
