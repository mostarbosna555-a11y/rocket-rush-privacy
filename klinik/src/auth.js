'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db, audit } = require('./db');

const SESSION_DAYS = 7;
const COOKIE = 'klinik_session';

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.prepare('INSERT INTO sessions(token, user_id, expires_at) VALUES(?, ?, ?)').run(
    token,
    userId,
    expires
  );
  return { token, expires };
}

function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function purgeExpired() {
  db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
}

function login(username, password) {
  const user = db
    .prepare('SELECT * FROM users WHERE username = ? AND active = 1')
    .get(String(username || '').trim());
  // Kullanici yoksa da bcrypt calistir: zamanlama farkindan kullanici adi sizmasin.
  const hash = user ? user.password_hash : '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin';
  const ok = bcrypt.compareSync(String(password || ''), hash);
  if (!user || !ok) return null;
  audit(user.id, 'auth.login', 'user', user.id, null);
  return user;
}

function changePassword(userId, currentPassword, newPassword) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error('Kullanıcı bulunamadı.');
  if (!bcrypt.compareSync(String(currentPassword || ''), user.password_hash)) {
    throw new Error('Mevcut şifre hatalı.');
  }
  if (String(newPassword || '').length < 6) {
    throw new Error('Yeni şifre en az 6 karakter olmalı.');
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
    bcrypt.hashSync(String(newPassword), 10),
    userId
  );
  // Diger oturumlari dusur.
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  audit(userId, 'auth.password_change', 'user', userId, null);
}

/** Oturumu req.user'a yerlestirir; oturum yoksa 401 doner. */
function requireAuth(req, res, next) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return res.status(401).json({ error: 'Oturum gerekli.' });
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.full_name, u.role
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token = ? AND s.expires_at > datetime('now') AND u.active = 1`
    )
    .get(token);
  if (!row) return res.status(401).json({ error: 'Oturum süresi dolmuş.' });
  req.user = row;
  req.sessionToken = token;
  next();
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Bu işlem için yönetici yetkisi gerekli.' });
  }
  next();
}

function setSessionCookie(res, token, expires) {
  const secure = process.env.COOKIE_SECURE === 'true';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Expires=${new Date(expires).toUTCString()}` +
      (secure ? '; Secure' : '')
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

module.exports = {
  COOKIE,
  parseCookies,
  createSession,
  destroySession,
  purgeExpired,
  login,
  changePassword,
  requireAuth,
  requireAdmin,
  setSessionCookie,
  clearSessionCookie,
};
