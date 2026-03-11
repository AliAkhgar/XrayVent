'use strict';

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

function generateUUID(username, password) { return `${username}-${password}`; }

function writeJsonPretty(filePath, obj) { fs.writeFileSync(filePath, JSON.stringify(obj, null, 2)); }

function buildXrayConfig({ activeOutbound = 'tun0-out', socksInPort, vlessInPort, apiListen, out1Host, out1Port, out2Host, out2Port, out3Host, out3Port, users }) {
  const [apiHost, apiPortStr] = String(apiListen || '127.0.0.1:4343').split(':');
  const apiPort = parseInt(apiPortStr, 10);

  const socksAccounts = (users || []).map(u => ({ user: u.username, pass: u.password, level: 0 }));
  const vlessClients = (users || []).map(u => ({ id: generateUUID(u.username, u.password), email: u.email || `${u.username}@vless.local`, level: 0 }));

  const userRoutingRule = activeOutbound === 'socks-balancer'
    ? { type: 'field', inboundTag: ['socks-in', 'vless-in'], balancerTag: 'socks-balancer' }
    : { type: 'field', inboundTag: ['socks-in', 'vless-in'], outboundTag: 'tun0-out' };

  return {
    log: { loglevel: 'warning', access: '', error: '' },
    api: { tag: 'api-core', services: ['StatsService', 'HandlerService'] },
    stats: {},
    policy: {
      levels: { '0': { statsUserUplink: true, statsUserDownlink: true } },
      system: { statsInboundUplink: true, statsInboundDownlink: true, statsOutboundUplink: true, statsOutboundDownlink: true }
    },
    inbounds: [
      { tag: 'socks-in', port: socksInPort, listen: '0.0.0.0', protocol: 'socks', settings: { auth: 'password', accounts: socksAccounts, udp: true } },
      { tag: 'vless-in', port: vlessInPort, listen: '0.0.0.0', protocol: 'vless', settings: { clients: vlessClients, decryption: 'none' }, streamSettings: { network: 'tcp', security: 'none' } },
      { tag: 'api-in', port: apiPort, listen: '127.0.0.1', protocol: 'dokodemo-door', settings: { address: '127.0.0.1' } }
    ],
    observatory: { subjectSelector: ["failover-out-"], probeURL: "http://1.1.1.1/generate_204", probeInterval: "10s" },
    outbounds: [
      {
        tag: 'tun0-out',
        protocol: 'freedom',
        settings: {},
        streamSettings: {
          sockopt: {
            interface: 'tun0'
          }
        }
      },
      { tag: 'failover-out-1', protocol: 'socks', settings: { servers: [{ address: out1Host, port: out1Port }] } },
      { tag: 'failover-out-2', protocol: 'socks', settings: { servers: [{ address: out2Host, port: out2Port }] } },
      { tag: 'failover-out-3', protocol: 'socks', settings: { servers: [{ address: out3Host, port: out3Port }] } },
      { tag: 'direct', protocol: 'freedom', settings: {} }
    ],
    routing: {
      balancers: [{ tag: "socks-balancer", selector: ["failover-out-"], strategy: { type: "leastPing" } }],
      rules: [
        { type: 'field', inboundTag: ['api-in'], outboundTag: 'api-core' },
        userRoutingRule
      ]
    }
  };
}

function startXray({ xrayBin, configPath, log }) {
  return new Promise((resolve, reject) => {
    try { JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (e) { return reject(new Error(`Invalid JSON: ${e.message}`)); }
    log?.(`[Manager] Spawning Xray...`);
    const proc = spawn(xrayBin, ['run', '-c', configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stderr.on('data', d => { const s = String(d).trim(); if (s && !s.includes('proxy/dokodemo')) log?.(`[Xray] ${s}`); });
    setTimeout(() => { if (proc.exitCode !== null) reject(new Error(`Exit early: ${proc.exitCode}`)); else resolve(proc); }, 500);
  });
}

function stopXray(proc, log) {
  return new Promise((resolve) => {
    if (!proc || proc.killed) return resolve();
    log?.('[Manager] Stopping Xray...');
    proc.kill('SIGTERM');
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} resolve(); }, 1000);
  });
}

async function getGlobalStats({ xrayBin, apiServer }) {
  return new Promise((resolve) => {
    execFile(xrayBin, ['api', 'statsquery', `--server=${apiServer}`], { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve({});
      try {
        const res = JSON.parse(stdout);
        const map = {};
        if (res && Array.isArray(res.stat)) res.stat.forEach(s => { map[s.name] = Number(s.value); });
        resolve(map);
      } catch (e) { resolve({}); }
    });
  });
}

module.exports = { writeJsonPretty, buildXrayConfig, startXray, stopXray, getGlobalStats, generateUUID };
