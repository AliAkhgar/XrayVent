'use strict';

const fs = require('fs');
const crypto = require('crypto');

function loadState(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return { users: Array.isArray(parsed.users) ? parsed.users : [] };
  } catch (e) {
    return { users: [] };
  }
}

function saveState(filePath, state) {
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
}

function upsertUser(users, draft) {
  const cleaned = normalizeUser(draft);
  const idx = users.findIndex(u => u.username === cleaned.username);
  if (idx >= 0) {
    users[idx] = { ...users[idx], ...cleaned, updatedAt: new Date().toISOString() };
    return users;
  }
  users.push(cleaned);
  return users;
}

function deleteUser(users, username) {
  return users.filter(u => u.username !== username);
}

function normalizeUser(d) {
  const now = new Date().toISOString();
  const username = String(d.username || '').trim();
  const password = String(d.password || '').trim();
  if (!username) throw new Error('username is required');
  if (!password) throw new Error('password is required');

  const email = String(d.email || `${username}@local`).trim();
  const quotaGiB = d.quotaGiB === null || d.quotaGiB === undefined || d.quotaGiB === '' ? null : Number(d.quotaGiB);
  const expiresAt = d.expiresAt ? new Date(d.expiresAt).toISOString() : null;

  return {
    id: d.id || crypto.randomUUID(),
    username,
    password,
    email,
    enabled: d.enabled === false ? false : true,
    quotaGiB: Number.isFinite(quotaGiB) ? quotaGiB : null,
    expiresAt,
    usedBytes: Number.isFinite(Number(d.usedBytes)) ? Number(d.usedBytes) : 0,
    createdAt: d.createdAt || now,
    updatedAt: d.updatedAt || now,
    lastSeenAt: d.lastSeenAt || null
  };
}

module.exports = { loadState, saveState, upsertUser, deleteUser };
