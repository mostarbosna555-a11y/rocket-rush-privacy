'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'klinik.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'veteriner',
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  protocol_no     INTEGER,
  card_no         TEXT,
  full_name       TEXT NOT NULL,
  gsm             TEXT,
  email           TEXT,
  identity_no     TEXT,
  birth_date      TEXT,
  mobile_username TEXT,
  mobile_password TEXT,
  allow_sms       INTEGER NOT NULL DEFAULT 1,
  allow_email     INTEGER NOT NULL DEFAULT 1,
  address         TEXT,
  district        TEXT,
  city            TEXT,
  description     TEXT,
  notes           TEXT,
  balance         REAL NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(full_name);
CREATE INDEX IF NOT EXISTS idx_customers_gsm  ON customers(gsm);

CREATE TABLE IF NOT EXISTS patients (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id  INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  protocol_no  INTEGER,
  card_no      TEXT,
  hbs_no       TEXT,
  chip_no      TEXT,
  name         TEXT NOT NULL,
  species      TEXT NOT NULL DEFAULT 'Kedi',
  breed        TEXT,
  gender       TEXT,
  color        TEXT,
  birth_date   TEXT,
  age_group    TEXT,
  blood_type   TEXT,
  weight       REAL,
  food_type    TEXT,
  breeding     INTEGER NOT NULL DEFAULT 0,
  adoption     INTEGER NOT NULL DEFAULT 0,
  neutered     INTEGER NOT NULL DEFAULT 0,
  deceased     INTEGER NOT NULL DEFAULT 0,
  notes        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_patients_customer ON patients(customer_id);
CREATE INDEX IF NOT EXISTS idx_patients_name     ON patients(name);

CREATE TABLE IF NOT EXISTS vaccine_types (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL UNIQUE,
  species        TEXT,
  interval_days  INTEGER NOT NULL DEFAULT 365,
  active         INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS vaccinations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id    INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  vaccine_name  TEXT NOT NULL,
  applied_date  TEXT,
  due_date      TEXT,
  status        TEXT NOT NULL DEFAULT 'planned',
  lot_no        TEXT,
  vet_user_id   INTEGER REFERENCES users(id),
  note          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_vacc_patient ON vaccinations(patient_id);
CREATE INDEX IF NOT EXISTS idx_vacc_due     ON vaccinations(due_date, status);

CREATE TABLE IF NOT EXISTS appointments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  patient_id  INTEGER REFERENCES patients(id) ON DELETE SET NULL,
  starts_at   TEXT NOT NULL,
  duration_min INTEGER NOT NULL DEFAULT 30,
  reason      TEXT,
  status      TEXT NOT NULL DEFAULT 'planned',
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_appt_start ON appointments(starts_at);

CREATE TABLE IF NOT EXISTS visits (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id  INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  visit_date  TEXT NOT NULL DEFAULT (date('now')),
  complaint   TEXT,
  diagnosis   TEXT,
  treatment   TEXT,
  weight      REAL,
  temperature REAL,
  fee         REAL NOT NULL DEFAULT 0,
  vet_user_id INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_visits_patient ON visits(patient_id);

CREATE TABLE IF NOT EXISTS sms_templates (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  kind       TEXT NOT NULL DEFAULT 'genel',
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sms_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id  INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  patient_id   INTEGER REFERENCES patients(id) ON DELETE SET NULL,
  gsm          TEXT NOT NULL,
  body         TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'genel',
  provider     TEXT,
  provider_tx  TEXT,
  status       TEXT NOT NULL DEFAULT 'queued',
  error        TEXT,
  segments     INTEGER NOT NULL DEFAULT 1,
  batch_id     TEXT,
  sent_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_smslog_sent  ON sms_log(sent_at);
CREATE INDEX IF NOT EXISTS idx_smslog_batch ON sms_log(batch_id);

-- Ayni hatirlatmanin iki kez gitmesini engeller.
CREATE TABLE IF NOT EXISTS reminder_sent (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_kind   TEXT NOT NULL,
  ref_id     INTEGER NOT NULL,
  sent_on    TEXT NOT NULL,
  sms_log_id INTEGER REFERENCES sms_log(id) ON DELETE SET NULL,
  UNIQUE(ref_kind, ref_id, sent_on)
);

CREATE TABLE IF NOT EXISTS blacklist (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  gsm        TEXT NOT NULL UNIQUE,
  reason     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  INTEGER,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

db.exec(SCHEMA);

const DEFAULT_SETTINGS = {
  clinic_name: 'Kliniğim',
  clinic_phone: '',
  sms_provider: 'mock',
  sms_api_key: '',
  sms_header_id: '',
  sms_header_title: '',
  sms_commercial_default: 'false',
  reminder_offset_days: '3',
  reminder_auto: 'false',
  birthday_enabled: 'true',
};

const DEFAULT_VACCINES = [
  ['KUDUZ', null, 365],
  ['YILLIK KEDİ KARMA', 'Kedi', 365],
  ['KEDİ KARMA 1', 'Kedi', 21],
  ['YILLIK KÖPEK KARMA', 'Köpek', 365],
  ['KÖPEK KARMA 1', 'Köpek', 21],
  ['İÇ PARAZİT 2 AYLIK', null, 60],
  ['DIŞ PARAZİT 2 AYLIK', null, 60],
  ['İÇ+DIŞ PARAZİT', null, 60],
  ['MANTAR', null, 365],
];

const DEFAULT_TEMPLATES = [
  [
    'Aşı Hatırlatma',
    'asi',
    'Sayın {musteri}, dostunuz {hasta} için {asi} aşısının zamanı geldi ({tarih}). Randevu için: {klinik_tel} - {klinik}',
  ],
  [
    'Randevu Hatırlatma',
    'randevu',
    'Sayın {musteri}, {hasta} için {tarih} tarihli randevunuzu hatırlatırız. {klinik}',
  ],
  [
    'Doğum Günü',
    'dogumgunu',
    'Sayın {musteri}, {hasta} için nice sağlıklı yıllar dileriz! {klinik}',
  ],
  ['Genel Duyuru', 'genel', 'Sayın {musteri}, {klinik} olarak bilgilendirmek isteriz: '],
];

function seed() {
  const setSetting = db.prepare(
    'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO NOTHING'
  );
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) setSetting.run(k, v);

  const insVaccine = db.prepare(
    'INSERT INTO vaccine_types(name, species, interval_days) VALUES(?, ?, ?) ON CONFLICT(name) DO NOTHING'
  );
  for (const row of DEFAULT_VACCINES) insVaccine.run(...row);

  const insTemplate = db.prepare(
    'INSERT INTO sms_templates(name, kind, body) VALUES(?, ?, ?) ON CONFLICT(name) DO NOTHING'
  );
  for (const row of DEFAULT_TEMPLATES) insTemplate.run(...row);

  const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (userCount === 0) {
    const password = process.env.ADMIN_PASSWORD || 'admin123';
    db.prepare(
      "INSERT INTO users(username, password_hash, full_name, role) VALUES(?, ?, ?, 'admin')"
    ).run('admin', bcrypt.hashSync(password, 10), 'Yönetici');
    if (!process.env.ADMIN_PASSWORD) {
      console.warn(
        '[klinik] İlk kullanıcı oluşturuldu: admin / admin123 — ilk girişten sonra şifreyi değiştirin.'
      );
    }
  }
}

seed();

const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const putSetting = db.prepare(
  'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

function setting(key, fallback = null) {
  const row = getSetting.get(key);
  return row ? row.value : fallback;
}

function setSettings(obj) {
  const tx = db.transaction((entries) => {
    for (const [k, v] of entries) putSetting.run(k, v == null ? '' : String(v));
  });
  tx(Object.entries(obj));
}

function allSettings() {
  const out = {};
  for (const row of db.prepare('SELECT key, value FROM settings').all()) out[row.key] = row.value;
  return out;
}

function audit(userId, action, entity, entityId, detail) {
  db.prepare(
    'INSERT INTO audit_log(user_id, action, entity, entity_id, detail) VALUES(?, ?, ?, ?, ?)'
  ).run(userId ?? null, action, entity ?? null, entityId ?? null, detail ?? null);
}

/** Bir sonraki protokol numarasini uretir (musteri ve hasta icin ayri sayaclar). */
function nextProtocol(table) {
  const row = db.prepare(`SELECT COALESCE(MAX(protocol_no), 0) AS n FROM ${table}`).get();
  return row.n + 1;
}

module.exports = { db, setting, setSettings, allSettings, audit, nextProtocol, DB_PATH };
