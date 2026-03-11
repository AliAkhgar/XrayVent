require('dotenv').config();
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
const util = require('util');
const execAsync = util.promisify(require('child_process').exec);

const { loadState, saveState, upsertUser, deleteUser, loadSettings, saveSettings } = require('./store');
const { buildXrayConfig, writeJsonPretty, startXray, stopXray, getGlobalStats } = require('./xray');
const { createTui } = require('./tui');
const { createWebServer } = require('./web/server');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const USERS_PATH = path.join(DATA_DIR, 'users.json');
const XRAY_CONFIG_PATH = path.join(DATA_DIR, 'xray.generated.json');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');

const WEB_PORT = parseInt(process.env.WEB_PORT || '3000', 10);
const WEB_ADMIN_USER = process.env.WEB_ADMIN_USER || 'admin';
const WEB_ADMIN_PASS = process.env.WEB_ADMIN_PASS || 'admin';

const XRAY_BIN = process.env.XRAY_BIN || '/root/goduser/xray_user';
const SOCKS_IN_PORT = parseInt(process.env.SOCKS_IN_PORT || '80', 10);
const VLESS_IN_PORT = parseInt(process.env.VLESS_IN_PORT || '443', 10);
const XRAY_API_SERVER = process.env.XRAY_API_SERVER || '127.0.0.1:4343';

const SOCKS_OUT_1_HOST = process.env.SOCKS_OUT_1_HOST || '127.0.0.1';
const SOCKS_OUT_1_PORT = parseInt(process.env.SOCKS_OUT_1_PORT || '2080', 10);
const SOCKS_OUT_2_HOST = process.env.SOCKS_OUT_2_HOST || '127.0.0.1';
const SOCKS_OUT_2_PORT = parseInt(process.env.SOCKS_OUT_2_PORT || '2081', 10);
const SOCKS_OUT_3_HOST = process.env.SOCKS_OUT_3_HOST || '127.0.0.1';
const SOCKS_OUT_3_PORT = parseInt(process.env.SOCKS_OUT_3_PORT || '2082', 10);

const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || '5000', 10); // ۵ ثانیه برای آپدیت UI
const HEALTH_CHECK_INTERVAL = parseInt(process.env.HEALTH_CHECK_INTERVAL_MS || '15000', 10); // ۱۵ ثانیه برای چک اینترنت

let xrayProc = null;
let tuiInstance = null;

const logBuffer = [];
const MAX_LOG_BUFFER = 500;
let webBroadcast = null;
const currentStats = {};

function addLog(msg) {
  const stripped = msg.replace(/\{[^}]*\}/g, '');
  const entry = { time: new Date().toISOString(), msg: stripped };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG_BUFFER) logBuffer.shift();
  tuiInstance?.log(msg);              // TUI gets blessed-tagged version
  if (webBroadcast) webBroadcast('log', entry); // Web gets clean version
}

let lastOut1Total = 0; let lastOut2Total = 0; let lastOut3Total = 0;

// متغیرهای مدیریت فیل‌اور
let activeOutbound = 'tun0-out';
let isCheckingHealth = false;
let tun0StableCount = 0;
const REQUIRED_STABLE_CHECKS = 2; // تونل باید ۲ بار متوالی (۳۰ ثانیه) سالم باشد تا سوییچ شود

function bytesToGiB(n) { return n / (1024 ** 3); }
function bytesToMiB(n) { return n / (1024 ** 2); }
function nowIso() { return new Date().toISOString(); }

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(USERS_PATH)) fs.writeFileSync(USERS_PATH, JSON.stringify({ users: [] }, null, 2));
}

function forceKillAll() { try { execSync("pkill -9 -f xray_user || true", { stdio: 'ignore' }); } catch (e) {} }

async function isTun0Healthy() {
  try {
    // اگر کارت شبکه وجود نداشته باشد، catch اجرا شده و false برمی‌گرداند.
    await execAsync('curl -s --interface tun0 --connect-timeout 3 -m 3 http://1.1.1.1/generate_204');
    return true;
  } catch (e) {
    return false;
  }
}

async function isAnySocksHealthy() {
  const proxies = [
    `socks5h://${SOCKS_OUT_1_HOST}:${SOCKS_OUT_1_PORT}`,
    `socks5h://${SOCKS_OUT_2_HOST}:${SOCKS_OUT_2_PORT}`,
    `socks5h://${SOCKS_OUT_3_HOST}:${SOCKS_OUT_3_PORT}`
  ];
  try {
    // به محض جواب دادن اولین SOCKS سالم، True برمی‌گرداند
    await Promise.any(proxies.map(proxy =>
      execAsync(`curl -s -x ${proxy} --connect-timeout 3 -m 3 http://1.1.1.1/generate_204`)
    ));
    return true;
  } catch (e) {
    return false;
  }
}

async function main() {
  forceKillAll(); ensureDirs();
  const state = loadState(USERS_PATH);

  async function startService() {
    if (xrayProc) return;
    forceKillAll();
    const cfg = buildXrayConfig({
      activeOutbound,
      socksInPort: SOCKS_IN_PORT, vlessInPort: VLESS_IN_PORT, apiListen: XRAY_API_SERVER,
      out1Host: SOCKS_OUT_1_HOST, out1Port: SOCKS_OUT_1_PORT,
      out2Host: SOCKS_OUT_2_HOST, out2Port: SOCKS_OUT_2_PORT,
      out3Host: SOCKS_OUT_3_HOST, out3Port: SOCKS_OUT_3_PORT,
      users: state.users.filter(u => u.enabled !== false)
    });
    writeJsonPretty(XRAY_CONFIG_PATH, cfg);
    try {
      xrayProc = await startXray({ xrayBin: XRAY_BIN, configPath: XRAY_CONFIG_PATH, log: addLog });
      addLog(`Service STARTED successfully. [Route: ${activeOutbound}]`);
    } catch (e) { addLog(`Start failed: ${e.message}`); }
  }

  async function stopService() {
    if (xrayProc) { await stopXray(xrayProc); xrayProc = null; }
    addLog('Service STOPPED.');
  }

  async function reloadService() { await stopService(); await startService(); }

  const appSettings = {
      vlessIn: VLESS_IN_PORT, socksIn: SOCKS_IN_PORT,
      out1: `${SOCKS_OUT_1_HOST}:${SOCKS_OUT_1_PORT}`,
      out2: `${SOCKS_OUT_2_HOST}:${SOCKS_OUT_2_PORT}`,
      out3: `${SOCKS_OUT_3_HOST}:${SOCKS_OUT_3_PORT}`
  };

  const tui = createTui({
    title: `Xray GodUser Manager`, settings: appSettings,
    onStart: startService, onStop: stopService,
    onKill: async () => { await stopService(); forceKillAll(); process.exit(0); },
    onAddUser: async (d) => { state.users = upsertUser(state.users, d); saveState(USERS_PATH, state); await reloadService(); },
    onDeleteUser: async (u) => { state.users = deleteUser(state.users, u); saveState(USERS_PATH, state); await reloadService(); },
    onToggleEnable: async (u) => {
      const user = state.users.find(x => x.username === u);
      if(user) { user.enabled = !user.enabled; saveState(USERS_PATH, state); await reloadService(); }
    }
  });
  tuiInstance = tui;

  // ──── Web UI ────
  const webCtx = {
    state, adminUser: WEB_ADMIN_USER, adminPass: WEB_ADMIN_PASS,
    usersPath: USERS_PATH, settingsPath: SETTINGS_PATH,
    isRunning: () => !!xrayProc,
    getActiveOutbound: () => activeOutbound,
    setActiveOutbound: (v) => { activeOutbound = v; },
    startService, stopService, reloadService,
    addLog, logBuffer, currentStats,
    outbounds: [
      { tag: 'tun0-out', type: 'freedom', label: 'TUN0 Direct' },
      { tag: 'failover-out-1', type: 'socks', label: 'SOCKS Proxy 1', host: SOCKS_OUT_1_HOST, port: SOCKS_OUT_1_PORT },
      { tag: 'failover-out-2', type: 'socks', label: 'SOCKS Proxy 2', host: SOCKS_OUT_2_HOST, port: SOCKS_OUT_2_PORT },
      { tag: 'failover-out-3', type: 'socks', label: 'SOCKS Proxy 3', host: SOCKS_OUT_3_HOST, port: SOCKS_OUT_3_PORT },
    ]
  };
  const { app: webApp, broadcast } = createWebServer(webCtx);
  webBroadcast = broadcast;
  webApp.listen(WEB_PORT, '0.0.0.0', () => addLog(`Web UI available on port ${WEB_PORT}`));

  await startService();

  // لوپ مانیتورینگ سلامت (Failover) - هر ۱۵ ثانیه
  setInterval(async () => {
    if (isCheckingHealth) return;
    const fo = loadSettings(SETTINGS_PATH);
    if (fo.failoverEnabled === false) return;       // failover disabled from web UI
    const requiredStable = fo.requiredStableChecks || REQUIRED_STABLE_CHECKS;
    isCheckingHealth = true;
    try {
      const tun0Ok = await isTun0Healthy();

      if (tun0Ok) {
        if (activeOutbound !== 'tun0-out') {
          tun0StableCount++;
          if (tun0StableCount >= requiredStable) {
            activeOutbound = 'tun0-out';
            tun0StableCount = 0;
            addLog('{green-fg}tun0 is STABLE. Switching back to PRIMARY.{/}');
            await reloadService();
          } else {
            addLog(`tun0 is UP. Verifying stability (${tun0StableCount}/${requiredStable})...`);
          }
        } else {
          tun0StableCount = 0;
        }
      } else {
        tun0StableCount = 0;
        if (activeOutbound === 'tun0-out') {
          const socksOk = await isAnySocksHealthy();
          if (socksOk) {
            activeOutbound = 'socks-balancer';
            addLog('{yellow-fg}tun0 DOWN. Switching to FAILOVER (SOCKS).{/}');
            await reloadService();
          } else {
            addLog('{red-fg}CRITICAL: tun0 DOWN, and all SOCKS also DEAD!{/}');
          }
        }
      }
    } catch (e) {}
    isCheckingHealth = false;
  }, HEALTH_CHECK_INTERVAL);

  // لوپ آپدیت UI و محاسبه ترافیک - هر ۵ ثانیه
  setInterval(async () => {
    const cpuLoad = os.loadavg()[0].toFixed(2);
    const usedMemPercent = (((os.totalmem() - os.freemem()) / os.totalmem()) * 100).toFixed(1);
    let totalUsedBytes = state.users.reduce((acc, u) => acc + (u.usedBytes || 0), 0);

    let out1StatusText = '{grey-fg}IDLE{/}'; let out2StatusText = '{grey-fg}IDLE{/}'; let out3StatusText = '{grey-fg}IDLE{/}';
    let out1GB = '0.00'; let out2GB = '0.00'; let out3GB = '0.00';

    if (xrayProc) {
      try {
        const statsMap = await getGlobalStats({ xrayBin: XRAY_BIN, apiServer: XRAY_API_SERVER });
        let anyChange = false;

        const out1Up = statsMap['outbound>>>failover-out-1>>>traffic>>>uplink'] || 0;
        const out1Down = statsMap['outbound>>>failover-out-1>>>traffic>>>downlink'] || 0;
        const out2Up = statsMap['outbound>>>failover-out-2>>>traffic>>>uplink'] || 0;
        const out2Down = statsMap['outbound>>>failover-out-2>>>traffic>>>downlink'] || 0;
        const out3Up = statsMap['outbound>>>failover-out-3>>>traffic>>>uplink'] || 0;
        const out3Down = statsMap['outbound>>>failover-out-3>>>traffic>>>downlink'] || 0;

        const currentOut1 = out1Up + out1Down;
        const currentOut2 = out2Up + out2Down;
        const currentOut3 = out3Up + out3Down;

        const delta1 = currentOut1 >= lastOut1Total ? currentOut1 - lastOut1Total : currentOut1;
        const delta2 = currentOut2 >= lastOut2Total ? currentOut2 - lastOut2Total : currentOut2;
        const delta3 = currentOut3 >= lastOut3Total ? currentOut3 - lastOut3Total : currentOut3;

        lastOut1Total = currentOut1; lastOut2Total = currentOut2; lastOut3Total = currentOut3;

        out1GB = bytesToGiB(currentOut1).toFixed(2); out2GB = bytesToGiB(currentOut2).toFixed(2); out3GB = bytesToGiB(currentOut3).toFixed(2);
        out1StatusText = delta1 > 0 ? '{green-fg}ACTIVE{/}' : '{grey-fg}IDLE{/}';
        out2StatusText = delta2 > 0 ? '{green-fg}ACTIVE{/}' : '{grey-fg}IDLE{/}';
        out3StatusText = delta3 > 0 ? '{green-fg}ACTIVE{/}' : '{grey-fg}IDLE{/}';

        for (const u of state.users) {
          if (u.enabled === false) continue;
          const vEmail = u.email || `${u.username}@vless.local`;
          const sUser = u.username;

          const currentTotal = (statsMap[`user>>>${vEmail}>>>traffic>>>uplink`] || 0) +
                               (statsMap[`user>>>${vEmail}>>>traffic>>>downlink`] || 0) +
                               (statsMap[`user>>>${sUser}>>>traffic>>>uplink`] || 0) +
                               (statsMap[`user>>>${sUser}>>>traffic>>>downlink`] || 0);

          const lastTotal = u._lastCheckTotal || 0;
          let delta = currentTotal < lastTotal ? currentTotal : currentTotal - lastTotal;

          if (delta > 0) {
            u.usedBytes = (u.usedBytes || 0) + delta;
            totalUsedBytes += delta;
            u._lastCheckTotal = currentTotal;
            u.lastSeenAt = nowIso();
            anyChange = true;
          }

          if (u.quotaGiB && u.usedBytes >= u.quotaGiB * (1024 ** 3)) {
             u.enabled = false; anyChange = true;
             addLog(`${u.username} disabled (Quota)`);
          }
        }

        if (anyChange) {
          saveState(USERS_PATH, state);
          if (webBroadcast) {
            webBroadcast('users', state.users.map(u => {
              const { _lastCheckTotal, ...clean } = u;
              return { ...clean, usedGiB: parseFloat(((u.usedBytes || 0) / (1024 ** 3)).toFixed(4)) };
            }));
          }
        }
        tui.setUsers(state.users.map(u => ({ ...u, usedGiB: bytesToGiB(u.usedBytes||0) })));

      } catch (e) { /* error silently */ }
    }

    const statsObj = {
       cpu: cpuLoad, ram: usedMemPercent, totalTraffic: bytesToGiB(totalUsedBytes).toFixed(2),
       usersCount: state.users.length, xrayStatus: xrayProc ? 'RUNNING' : 'STOPPED',
       out1StatusText, out2StatusText, out3StatusText, out1GB, out2GB, out3GB,
       activeOutbound
    };
    tui.setStats(statsObj);

    // Broadcast clean stats to Web UI
    const webStats = {
      cpu: cpuLoad, ram: usedMemPercent,
      totalTraffic: bytesToGiB(totalUsedBytes).toFixed(2),
      usersCount: state.users.length,
      xrayStatus: xrayProc ? 'RUNNING' : 'STOPPED',
      out1GB, out2GB, out3GB,
      out1Active: out1StatusText.includes('ACTIVE'),
      out2Active: out2StatusText.includes('ACTIVE'),
      out3Active: out3StatusText.includes('ACTIVE'),
      activeOutbound
    };
    Object.assign(currentStats, webStats);
    if (webBroadcast) webBroadcast('stats', webStats);

  }, POLL_INTERVAL);
}

main();
