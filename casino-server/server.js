// Fake Casino leaderboard. Stores only nickname + best fake balance + bailouts per player.
// Admin (PIN from ADMIN_PIN env) can delete entries and reset the board. It cannot edit balances.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || '';
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data'));
const DB_FILE = path.join(DATA_DIR, 'leaderboard.json');
const MAX_BALANCE = 1e12;

fs.mkdirSync(DATA_DIR, { recursive: true });
let players = {};
try { players = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) {}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(players));
    fs.renameSync(DB_FILE + '.tmp', DB_FILE);
  }, 500);
}

// Simple per-IP limits: score posts, and failed admin PIN attempts (lockout after 5).
const hits = new Map(), pinFails = new Map();
function rateLimited(ip) {
  const now = Date.now(), h = hits.get(ip) || { n: 0, t: now };
  if (now - h.t > 60_000) { h.n = 0; h.t = now; }
  h.n++; hits.set(ip, h);
  return h.n > 60;
}
function pinLocked(ip) { const f = pinFails.get(ip); return f && f.n >= 5 && Date.now() - f.t < 15 * 60_000; }
function checkPin(ip, pin) {
  if (!ADMIN_PIN || pinLocked(ip)) return false;
  if (String(pin) === ADMIN_PIN) { pinFails.delete(ip); return true; }
  const f = pinFails.get(ip) || { n: 0, t: 0 };
  if (Date.now() - f.t > 15 * 60_000) f.n = 0;
  f.n++; f.t = Date.now(); pinFails.set(ip, f);
  return false;
}

const cleanName = n => String(n || '').replace(/[<>&"'`\u0000-\u001f]/g, '').trim().slice(0, 16);
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9-]{8,64}$/.test(id);

function board() {
  return Object.entries(players)
    .map(([id, p]) => ({ id, name: p.name, best: p.best, bailouts: p.bailouts, updated: p.updated }))
    .sort((a, b) => b.best - a.best)
    .slice(0, 100);
}

function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 4096) { reject(new Error('too big')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); } });
  });
}

http.createServer(async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const url = req.url.split('?')[0];
  if (req.method === 'OPTIONS') return send(res, 204, {});
  try {
    if (req.method === 'GET' && url === '/health') return send(res, 200, { ok: true });
    if (req.method === 'GET' && url === '/api/leaderboard') return send(res, 200, board());

    if (req.method === 'POST' && url === '/api/score') {
      if (rateLimited(ip)) return send(res, 429, { error: 'slow down' });
      const { id, name, balance, bailouts } = await readJson(req);
      const nick = cleanName(name);
      const bal = Math.floor(Number(balance)), bo = Math.floor(Number(bailouts));
      if (!validId(id) || !nick || !(bal >= 0 && bal <= MAX_BALANCE) || !(bo >= 0 && bo <= 1e6)) {
        return send(res, 400, { error: 'bad input' });
      }
      const p = players[id] || { best: 0 };
      players[id] = { name: nick, best: Math.max(p.best, bal), bailouts: bo, updated: Date.now() };
      save();
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.startsWith('/api/admin/')) {
      const body = await readJson(req);
      if (pinLocked(ip)) return send(res, 429, { error: 'too many wrong PINs, try again in 15 minutes' });
      if (!checkPin(ip, body.pin)) return send(res, 401, { error: 'wrong PIN' });
      if (url === '/api/admin/login') return send(res, 200, { ok: true });
      if (url === '/api/admin/delete') {
        if (!validId(body.id) || !players[body.id]) return send(res, 404, { error: 'not found' });
        delete players[body.id]; save();
        return send(res, 200, { ok: true });
      }
      if (url === '/api/admin/reset') { players = {}; save(); return send(res, 200, { ok: true }); }
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 400, { error: 'bad request' });
  }
}).listen(PORT, () => console.log(`Leaderboard on :${PORT}, data in ${DB_FILE}, admin ${ADMIN_PIN ? 'enabled' : 'DISABLED (no ADMIN_PIN)'}`));
