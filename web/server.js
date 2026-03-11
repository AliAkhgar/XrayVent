'use strict';

const express = require('express');
const crypto  = require('crypto');
const path    = require('path');
const { loadState, saveState, upsertUser, deleteUser, loadSettings, saveSettings } = require('../store');

/* ================================================================
   createWebServer(ctx)
   ctx must provide:
     state, adminUser, adminPass, usersPath, settingsPath,
     isRunning, getActiveOutbound, setActiveOutbound,
     startService, stopService, reloadService,
     addLog, logBuffer, currentStats, outbounds[]
   ================================================================ */
function createWebServer(ctx) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  /* ──── Token store ──── */
  const tokens   = new Map();
  const TOKEN_TTL = 24 * 60 * 60 * 1000;          // 24 h

  setInterval(() => {                              // cleanup expired
    const now = Date.now();
    for (const [t, exp] of tokens) { if (now > exp) tokens.delete(t); }
  }, 60 * 60 * 1000);

  function auth(req, res, next) {
    const h = req.headers.authorization;
    if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    const token = h.slice(7);
    const exp   = tokens.get(token);
    if (!exp || Date.now() > exp) { tokens.delete(token); return res.status(401).json({ error: 'Token expired' }); }
    next();
  }

  /* ──── SSE ──── */
  const sseClients = new Set();

  function broadcast(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
      try { client.write(msg); } catch { sseClients.delete(client); }
    }
  }

  /* ════════════════════  ROUTES  ════════════════════ */

  // ── Auth ──
  app.post('/api/login', (req, res) => {
    const { username, password } = req.body || {};
    if (username === ctx.adminUser && password === ctx.adminPass) {
      const token = crypto.randomBytes(32).toString('hex');
      tokens.set(token, Date.now() + TOKEN_TTL);
      return res.json({ token });
    }
    res.status(401).json({ error: 'Invalid credentials' });
  });

  app.get('/api/validate', auth, (_req, res) => res.json({ valid: true }));

  // ── Status ──
  app.get('/api/status', auth, (_req, res) => res.json(ctx.currentStats));

  // ── Users ──
  app.get('/api/users', auth, (_req, res) => {
    const users = ctx.state.users.map(u => {
      const { _lastCheckTotal, ...clean } = u;
      return { ...clean, usedGiB: parseFloat(((u.usedBytes || 0) / (1024 ** 3)).toFixed(4)) };
    });
    res.json(users);
  });

  app.post('/api/users', auth, async (req, res) => {
    try {
      ctx.state.users = upsertUser(ctx.state.users, req.body);
      saveState(ctx.usersPath, ctx.state);
      await ctx.reloadService();
      ctx.addLog(`[Web] User "${req.body.username}" added/updated`);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.delete('/api/users/:username', auth, async (req, res) => {
    ctx.state.users = deleteUser(ctx.state.users, req.params.username);
    saveState(ctx.usersPath, ctx.state);
    await ctx.reloadService();
    ctx.addLog(`[Web] User "${req.params.username}" deleted`);
    res.json({ ok: true });
  });

  app.patch('/api/users/:username/toggle', auth, async (req, res) => {
    const user = ctx.state.users.find(u => u.username === req.params.username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.enabled = !user.enabled;
    saveState(ctx.usersPath, ctx.state);
    await ctx.reloadService();
    ctx.addLog(`[Web] User "${req.params.username}" ${user.enabled ? 'enabled' : 'disabled'}`);
    res.json({ ok: true, enabled: user.enabled });
  });

  // ── Tunnels ──
  app.get('/api/tunnels', auth, (_req, res) => {
    const settings = loadSettings(ctx.settingsPath);
    res.json({
      order: settings.tunnelOrder || ['tun0-out', 'failover-out-1', 'failover-out-2', 'failover-out-3'],
      activeOutbound: ctx.getActiveOutbound(),
      failoverEnabled: settings.failoverEnabled !== false,
      outbounds: ctx.outbounds
    });
  });

  app.put('/api/tunnels/order', auth, async (req, res) => {
    const { order } = req.body;
    if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array' });
    const settings = loadSettings(ctx.settingsPath);
    settings.tunnelOrder = order;
    saveSettings(ctx.settingsPath, settings);
    ctx.addLog(`[Web] Tunnel order updated: ${order.join(' → ')}`);
    res.json({ ok: true });
  });

  app.put('/api/tunnels/primary', auth, async (req, res) => {
    const { outbound } = req.body;
    const validTags = ctx.outbounds.map(o => o.tag).concat(['socks-balancer']);
    if (!validTags.includes(outbound)) return res.status(400).json({ error: 'Invalid outbound tag' });
    ctx.setActiveOutbound(outbound);
    ctx.addLog(`[Web] Active outbound set to: ${outbound}`);
    await ctx.reloadService();
    res.json({ ok: true, activeOutbound: outbound });
  });

  // ── Settings ──
  app.get('/api/settings', auth, (_req, res) => res.json(loadSettings(ctx.settingsPath)));

  app.put('/api/settings', auth, (req, res) => {
    const current = loadSettings(ctx.settingsPath);
    const allowed = ['failoverEnabled', 'requiredStableChecks', 'tunnelOrder'];
    for (const key of allowed) {
      if (req.body[key] !== undefined) current[key] = req.body[key];
    }
    saveSettings(ctx.settingsPath, current);
    ctx.addLog('[Web] Settings updated');
    res.json({ ok: true });
  });

  // ── Logs ──
  app.get('/api/logs', auth, (_req, res) => res.json(ctx.logBuffer));

  // ── SSE stream ──
  app.get('/api/events', (req, res) => {
    const token = req.query.token;
    const exp   = tokens.get(token);
    if (!exp || Date.now() > exp) return res.status(401).json({ error: 'Unauthorized' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  });

  // ── SPA fallback ──
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  return { app, broadcast };
}

module.exports = { createWebServer };
