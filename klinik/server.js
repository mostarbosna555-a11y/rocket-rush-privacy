'use strict';

const path = require('path');
const express = require('express');

const { db, allSettings, setSettings, audit } = require('./src/db');
const auth = require('./src/auth');
const records = require('./src/routes/records');
const messaging = require('./src/routes/messaging');
const reminders = require('./src/reminders');
const { OrganikClient, OrganikError } = require('./src/sms/organik');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

const PORT = Number(process.env.PORT) || 3000;

/* ----------------------------------- Auth ----------------------------------- */

app.post('/api/login', (req, res) => {
  const user = auth.login(req.body.username, req.body.password);
  if (!user) return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı.' });
  const { token, expires } = auth.createSession(user.id);
  auth.setSessionCookie(res, token, expires);
  res.json({ id: user.id, username: user.username, full_name: user.full_name, role: user.role });
});

app.post('/api/logout', auth.requireAuth, (req, res) => {
  auth.destroySession(req.sessionToken);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/me', auth.requireAuth, (req, res) => res.json(req.user));

app.post('/api/me/password', auth.requireAuth, (req, res) => {
  try {
    auth.changePassword(req.user.id, req.body.current_password, req.body.new_password);
    auth.clearSessionCookie(res);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* ------------------------------- Korumali API -------------------------------- */

app.use('/api', auth.requireAuth);

app.get('/api/dashboard', (_req, res) => res.json(reminders.dashboard()));

app.use('/api', records);
app.use('/api', messaging);

/* --------------------------------- Ayarlar ---------------------------------- */

// API anahtari istemciye asla tam gonderilmez.
function maskedSettings() {
  const s = allSettings();
  if (s.sms_api_key) s.sms_api_key = '••••' + s.sms_api_key.slice(-4);
  s.sms_api_key_set = String(!!allSettings().sms_api_key);
  return s;
}

app.get('/api/settings', (_req, res) => res.json(maskedSettings()));

app.put('/api/settings', auth.requireAdmin, (req, res) => {
  const allowed = [
    'clinic_name', 'clinic_phone', 'sms_provider', 'sms_api_key',
    'sms_header_id', 'sms_header_title', 'sms_commercial_default',
    'reminder_offset_days', 'reminder_auto', 'birthday_enabled',
  ];
  const patch = {};
  for (const k of allowed) {
    if (req.body[k] === undefined) continue;
    // Maskeli deger geri gonderildiyse anahtari degistirme.
    if (k === 'sms_api_key' && String(req.body[k]).startsWith('••••')) continue;
    patch[k] = req.body[k];
  }
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Değişiklik yok.' });
  setSettings(patch);
  audit(req.user.id, 'settings.update', null, null, Object.keys(patch).join(','));
  res.json(maskedSettings());
});

/** Girilen API anahtarini kaydetmeden dogrular. */
app.post('/api/settings/test-sms', auth.requireAdmin, async (req, res) => {
  const key = req.body.api_key && !String(req.body.api_key).startsWith('••••')
    ? req.body.api_key
    : allSettings().sms_api_key;
  if (!key) return res.status(400).json({ error: 'API anahtarı girilmedi.' });
  try {
    const client = new OrganikClient(key);
    const [me, balance, headers] = await Promise.all([
      client.me(),
      client.balance(),
      client.headers(),
    ]);
    res.json({ ok: true, me, balance, headers });
  } catch (err) {
    const status = err instanceof OrganikError && err.code === 401 ? 401 : 400;
    res.status(status).json({ error: err.message, code: err.code });
  }
});

app.get('/api/users', auth.requireAdmin, (_req, res) => {
  res.json(db.prepare('SELECT id, username, full_name, role, active, created_at FROM users').all());
});

/* ------------------------------- Statik dosyalar ----------------------------- */

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// Bilinmeyen /api yollari JSON hata dondursun, digerleri tek sayfa uygulamaya dussun.
app.use('/api', (_req, res) => res.status(404).json({ error: 'Bulunamadı.' }));
app.use((_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

/* --------------------------------- Hata yakala ------------------------------- */

app.use((err, _req, res, _next) => {
  if (err instanceof OrganikError) {
    console.error('[sms]', err.code, err.message);
    return res.status(502).json({ error: err.message, code: err.code });
  }
  console.error('[hata]', err);
  res.status(500).json({ error: 'Sunucu hatası: ' + (err.message || 'bilinmeyen') });
});

/* ----------------------------------- Bakim ----------------------------------- */

auth.purgeExpired();
setInterval(auth.purgeExpired, 6 * 3600 * 1000).unref();

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[klinik] http://localhost:${PORT} adresinde çalışıyor`);
  });
}

module.exports = app;
