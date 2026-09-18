'use strict';

/** Musteri, hasta, asi, randevu ve muayene kayitlari. */

const express = require('express');
const { db, audit, nextProtocol } = require('../db');
const { normalizeGsm, isoDate, addDays, ageText, ageGroup } = require('../util');

const router = express.Router();

// Istemciden gelen alanlari beyaz listeye gore suzer.
function pick(body, fields) {
  const out = {};
  for (const f of fields) if (Object.prototype.hasOwnProperty.call(body, f)) out[f] = body[f];
  return out;
}

function bool(v) {
  return v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0;
}

/* ---------------------------------- Musteri --------------------------------- */

const CUSTOMER_FIELDS = [
  'card_no', 'full_name', 'gsm', 'email', 'identity_no', 'birth_date',
  'mobile_username', 'mobile_password', 'allow_sms', 'allow_email',
  'address', 'district', 'city', 'description', 'notes',
];

router.get('/customers', (req, res) => {
  const q = String(req.query.q || '').trim();
  const like = `%${q}%`;
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const rows = db
    .prepare(
      `SELECT c.*,
              (SELECT COUNT(*) FROM patients p WHERE p.customer_id = c.id AND p.deleted_at IS NULL) AS patient_count
         FROM customers c
        WHERE c.deleted_at IS NULL
          AND (? = '' OR c.full_name LIKE ? OR c.gsm LIKE ? OR c.identity_no LIKE ?
               OR EXISTS(SELECT 1 FROM patients p2 WHERE p2.customer_id = c.id AND p2.name LIKE ?))
        ORDER BY c.full_name COLLATE NOCASE
        LIMIT ?`
    )
    .all(q, like, like, like, like, limit);
  res.json({ count: rows.length, rows });
});

router.get('/customers/:id', (req, res) => {
  const c = db
    .prepare('SELECT * FROM customers WHERE id = ? AND deleted_at IS NULL')
    .get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Müşteri bulunamadı.' });
  const patients = db
    .prepare('SELECT * FROM patients WHERE customer_id = ? AND deleted_at IS NULL ORDER BY name')
    .all(c.id)
    .map((p) => ({ ...p, age_text: ageText(p.birth_date) }));
  res.json({ ...c, patients });
});

router.post('/customers', (req, res) => {
  const data = pick(req.body, CUSTOMER_FIELDS);
  if (!data.full_name || !String(data.full_name).trim()) {
    return res.status(400).json({ error: 'Adı Soyadı zorunludur.' });
  }
  if (data.gsm && !normalizeGsm(data.gsm)) {
    return res.status(400).json({ error: 'GSM numarası geçersiz. Örnek: 0542 405 61 45' });
  }
  data.gsm = data.gsm ? normalizeGsm(data.gsm) : null;
  data.allow_sms = bool(data.allow_sms ?? 1);
  data.allow_email = bool(data.allow_email ?? 1);
  data.protocol_no = nextProtocol('customers');

  const cols = Object.keys(data);
  const info = db
    .prepare(
      `INSERT INTO customers(${cols.join(',')}) VALUES(${cols.map((c) => '@' + c).join(',')})`
    )
    .run(data);
  audit(req.user.id, 'customer.create', 'customer', info.lastInsertRowid, data.full_name);
  res.status(201).json({ id: info.lastInsertRowid });
});

router.put('/customers/:id', (req, res) => {
  const data = pick(req.body, CUSTOMER_FIELDS);
  if (Object.keys(data).length === 0) return res.status(400).json({ error: 'Değişiklik yok.' });
  if (data.gsm !== undefined) {
    if (data.gsm && !normalizeGsm(data.gsm)) {
      return res.status(400).json({ error: 'GSM numarası geçersiz.' });
    }
    data.gsm = data.gsm ? normalizeGsm(data.gsm) : null;
  }
  if (data.allow_sms !== undefined) data.allow_sms = bool(data.allow_sms);
  if (data.allow_email !== undefined) data.allow_email = bool(data.allow_email);

  const sets = Object.keys(data).map((k) => `${k} = @${k}`);
  const info = db
    .prepare(
      `UPDATE customers SET ${sets.join(', ')}, updated_at = datetime('now')
        WHERE id = @id AND deleted_at IS NULL`
    )
    .run({ ...data, id: req.params.id });
  if (info.changes === 0) return res.status(404).json({ error: 'Müşteri bulunamadı.' });
  audit(req.user.id, 'customer.update', 'customer', Number(req.params.id), Object.keys(data).join(','));
  res.json({ ok: true });
});

// Yumusak silme: kayitlar (asi gecmisi, SMS logu) korunur.
router.delete('/customers/:id', (req, res) => {
  const info = db
    .prepare("UPDATE customers SET deleted_at = datetime('now') WHERE id = ? AND deleted_at IS NULL")
    .run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Müşteri bulunamadı.' });
  db.prepare("UPDATE patients SET deleted_at = datetime('now') WHERE customer_id = ?").run(
    req.params.id
  );
  audit(req.user.id, 'customer.delete', 'customer', Number(req.params.id), null);
  res.json({ ok: true });
});

/* ---------------------------------- Hasta ----------------------------------- */

const PATIENT_FIELDS = [
  'customer_id', 'card_no', 'hbs_no', 'chip_no', 'name', 'species', 'breed', 'gender',
  'color', 'birth_date', 'age_group', 'blood_type', 'weight', 'food_type',
  'breeding', 'adoption', 'neutered', 'deceased', 'notes',
];

router.get('/patients', (req, res) => {
  const q = String(req.query.q || '').trim();
  const like = `%${q}%`;
  const rows = db
    .prepare(
      `SELECT p.*, c.full_name AS customer_name, c.gsm
         FROM patients p JOIN customers c ON c.id = p.customer_id
        WHERE p.deleted_at IS NULL AND c.deleted_at IS NULL
          AND (? = '' OR p.name LIKE ? OR c.full_name LIKE ? OR p.chip_no LIKE ?)
        ORDER BY p.name COLLATE NOCASE LIMIT 300`
    )
    .all(q, like, like, like);
  res.json({ count: rows.length, rows: rows.map((p) => ({ ...p, age_text: ageText(p.birth_date) })) });
});

router.get('/patients/:id', (req, res) => {
  const p = db
    .prepare(
      `SELECT p.*, c.full_name AS customer_name, c.gsm, c.allow_sms
         FROM patients p JOIN customers c ON c.id = p.customer_id
        WHERE p.id = ? AND p.deleted_at IS NULL`
    )
    .get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Hasta bulunamadı.' });

  const vaccinations = db
    .prepare('SELECT * FROM vaccinations WHERE patient_id = ? ORDER BY COALESCE(applied_date, due_date) DESC')
    .all(p.id);
  const visits = db
    .prepare('SELECT * FROM visits WHERE patient_id = ? ORDER BY visit_date DESC LIMIT 50')
    .all(p.id);
  const appointments = db
    .prepare('SELECT * FROM appointments WHERE patient_id = ? ORDER BY starts_at DESC LIMIT 50')
    .all(p.id);

  res.json({ ...p, age_text: ageText(p.birth_date), vaccinations, visits, appointments });
});

router.post('/patients', (req, res) => {
  const data = pick(req.body, PATIENT_FIELDS);
  if (!data.customer_id) return res.status(400).json({ error: 'Müşteri seçilmedi.' });
  if (!data.name || !String(data.name).trim()) {
    return res.status(400).json({ error: 'Hasta adı zorunludur.' });
  }
  const owner = db
    .prepare('SELECT id FROM customers WHERE id = ? AND deleted_at IS NULL')
    .get(data.customer_id);
  if (!owner) return res.status(400).json({ error: 'Müşteri bulunamadı.' });

  for (const f of ['breeding', 'adoption', 'neutered', 'deceased']) {
    if (data[f] !== undefined) data[f] = bool(data[f]);
  }
  if (!data.age_group && data.birth_date) data.age_group = ageGroup(data.birth_date);
  data.protocol_no = nextProtocol('patients');

  const cols = Object.keys(data);
  const info = db
    .prepare(`INSERT INTO patients(${cols.join(',')}) VALUES(${cols.map((c) => '@' + c).join(',')})`)
    .run(data);
  audit(req.user.id, 'patient.create', 'patient', info.lastInsertRowid, data.name);
  res.status(201).json({ id: info.lastInsertRowid });
});

router.put('/patients/:id', (req, res) => {
  const data = pick(req.body, PATIENT_FIELDS);
  delete data.customer_id; // sahip degisikligi ayri bir islem (yonlendirme)
  if (Object.keys(data).length === 0) return res.status(400).json({ error: 'Değişiklik yok.' });
  for (const f of ['breeding', 'adoption', 'neutered', 'deceased']) {
    if (data[f] !== undefined) data[f] = bool(data[f]);
  }
  const sets = Object.keys(data).map((k) => `${k} = @${k}`);
  const info = db
    .prepare(
      `UPDATE patients SET ${sets.join(', ')}, updated_at = datetime('now')
        WHERE id = @id AND deleted_at IS NULL`
    )
    .run({ ...data, id: req.params.id });
  if (info.changes === 0) return res.status(404).json({ error: 'Hasta bulunamadı.' });
  audit(req.user.id, 'patient.update', 'patient', Number(req.params.id), null);
  res.json({ ok: true });
});

router.delete('/patients/:id', (req, res) => {
  const info = db
    .prepare("UPDATE patients SET deleted_at = datetime('now') WHERE id = ? AND deleted_at IS NULL")
    .run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Hasta bulunamadı.' });
  audit(req.user.id, 'patient.delete', 'patient', Number(req.params.id), null);
  res.json({ ok: true });
});

/** Hastayi baska bir musteriye devreder (E-vet'teki "Yönlendir"). */
router.post('/patients/:id/transfer', (req, res) => {
  const target = db
    .prepare('SELECT id FROM customers WHERE id = ? AND deleted_at IS NULL')
    .get(req.body.customer_id);
  if (!target) return res.status(400).json({ error: 'Hedef müşteri bulunamadı.' });
  const info = db
    .prepare("UPDATE patients SET customer_id = ?, updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL")
    .run(target.id, req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Hasta bulunamadı.' });
  audit(req.user.id, 'patient.transfer', 'patient', Number(req.params.id), `-> ${target.id}`);
  res.json({ ok: true });
});

/* ---------------------------------- Asilar ---------------------------------- */

router.get('/vaccine-types', (_req, res) => {
  res.json(db.prepare('SELECT * FROM vaccine_types WHERE active = 1 ORDER BY name').all());
});

router.post('/vaccine-types', (req, res) => {
  const { name, species, interval_days } = req.body;
  if (!name) return res.status(400).json({ error: 'Aşı adı zorunludur.' });
  try {
    const info = db
      .prepare('INSERT INTO vaccine_types(name, species, interval_days) VALUES(?, ?, ?)')
      .run(String(name).trim(), species || null, Number(interval_days) || 365);
    res.status(201).json({ id: info.lastInsertRowid });
  } catch {
    res.status(409).json({ error: 'Bu aşı adı zaten kayıtlı.' });
  }
});

/**
 * Asi kaydi ekler. `applied_date` verilirse asi yapilmis sayilir ve
 * asi tipinin periyoduna gore bir sonraki doz otomatik planlanir.
 */
router.post('/patients/:id/vaccinations', (req, res) => {
  const patient = db
    .prepare('SELECT id, species FROM patients WHERE id = ? AND deleted_at IS NULL')
    .get(req.params.id);
  if (!patient) return res.status(404).json({ error: 'Hasta bulunamadı.' });

  const { vaccine_name, applied_date, due_date, lot_no, note, schedule_next = true } = req.body;
  if (!vaccine_name) return res.status(400).json({ error: 'Aşı adı zorunludur.' });
  if (!applied_date && !due_date) {
    return res.status(400).json({ error: 'Yapılış veya planlanan tarihten biri girilmelidir.' });
  }

  const type = db.prepare('SELECT * FROM vaccine_types WHERE name = ?').get(vaccine_name);
  const interval = type ? type.interval_days : 365;

  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO vaccinations(patient_id, vaccine_name, applied_date, due_date, status, lot_no, vet_user_id, note)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        patient.id,
        vaccine_name,
        applied_date || null,
        applied_date ? null : due_date,
        applied_date ? 'done' : 'planned',
        lot_no || null,
        req.user.id,
        note || null
      );

    let nextId = null;
    if (applied_date && schedule_next) {
      const next = addDays(String(applied_date).slice(0, 10), interval);
      // Ayni asi icin zaten planlanmis bir doz varsa tekrar olusturma.
      const exists = db
        .prepare(
          "SELECT id FROM vaccinations WHERE patient_id = ? AND vaccine_name = ? AND status = 'planned'"
        )
        .get(patient.id, vaccine_name);
      if (!exists) {
        nextId = db
          .prepare(
            `INSERT INTO vaccinations(patient_id, vaccine_name, due_date, status)
             VALUES(?, ?, ?, 'planned')`
          )
          .run(patient.id, vaccine_name, next).lastInsertRowid;
      }
    }
    return { id: info.lastInsertRowid, nextId };
  });

  const out = tx();
  audit(req.user.id, 'vaccination.create', 'patient', patient.id, vaccine_name);
  res.status(201).json(out);
});

/** Planlanmis bir asiyi "yapildi" olarak isaretler ve bir sonrakini planlar. */
router.post('/vaccinations/:id/complete', (req, res) => {
  const v = db.prepare('SELECT * FROM vaccinations WHERE id = ?').get(req.params.id);
  if (!v) return res.status(404).json({ error: 'Aşı kaydı bulunamadı.' });
  if (v.status === 'done') return res.status(400).json({ error: 'Bu aşı zaten yapılmış.' });

  const applied = String(req.body.applied_date || isoDate()).slice(0, 10);
  const type = db.prepare('SELECT * FROM vaccine_types WHERE name = ?').get(v.vaccine_name);
  const interval = type ? type.interval_days : 365;

  const tx = db.transaction(() => {
    db.prepare(
      "UPDATE vaccinations SET status = 'done', applied_date = ?, due_date = NULL, vet_user_id = ? WHERE id = ?"
    ).run(applied, req.user.id, v.id);
    return db
      .prepare(
        "INSERT INTO vaccinations(patient_id, vaccine_name, due_date, status) VALUES(?, ?, ?, 'planned')"
      )
      .run(v.patient_id, v.vaccine_name, addDays(applied, interval)).lastInsertRowid;
  });

  const nextId = tx();
  audit(req.user.id, 'vaccination.complete', 'vaccination', v.id, v.vaccine_name);
  res.json({ ok: true, nextId });
});

router.delete('/vaccinations/:id', (req, res) => {
  const info = db.prepare('DELETE FROM vaccinations WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Aşı kaydı bulunamadı.' });
  audit(req.user.id, 'vaccination.delete', 'vaccination', Number(req.params.id), null);
  res.json({ ok: true });
});

/* --------------------------------- Randevu ---------------------------------- */

router.get('/appointments', (req, res) => {
  const from = req.query.from || isoDate();
  const to = req.query.to || addDays(from, 7);
  const rows = db
    .prepare(
      `SELECT a.*, p.name AS patient_name, c.full_name AS customer_name, c.gsm
         FROM appointments a
         LEFT JOIN patients  p ON p.id = a.patient_id
         LEFT JOIN customers c ON c.id = COALESCE(a.customer_id, p.customer_id)
        WHERE date(a.starts_at) BETWEEN ? AND ?
        ORDER BY a.starts_at`
    )
    .all(from, to);
  res.json({ from, to, rows });
});

router.post('/appointments', (req, res) => {
  const { customer_id, patient_id, starts_at, duration_min, reason, note } = req.body;
  if (!starts_at) return res.status(400).json({ error: 'Randevu tarihi zorunludur.' });
  const info = db
    .prepare(
      `INSERT INTO appointments(customer_id, patient_id, starts_at, duration_min, reason, note)
       VALUES(?, ?, ?, ?, ?, ?)`
    )
    .run(
      customer_id || null,
      patient_id || null,
      String(starts_at).replace('T', ' ').slice(0, 19),
      Number(duration_min) || 30,
      reason || null,
      note || null
    );
  audit(req.user.id, 'appointment.create', 'appointment', info.lastInsertRowid, reason || null);
  res.status(201).json({ id: info.lastInsertRowid });
});

router.put('/appointments/:id', (req, res) => {
  const data = pick(req.body, ['starts_at', 'duration_min', 'reason', 'status', 'note']);
  if (Object.keys(data).length === 0) return res.status(400).json({ error: 'Değişiklik yok.' });
  if (data.starts_at) data.starts_at = String(data.starts_at).replace('T', ' ').slice(0, 19);
  const sets = Object.keys(data).map((k) => `${k} = @${k}`);
  const info = db
    .prepare(`UPDATE appointments SET ${sets.join(', ')} WHERE id = @id`)
    .run({ ...data, id: req.params.id });
  if (info.changes === 0) return res.status(404).json({ error: 'Randevu bulunamadı.' });
  res.json({ ok: true });
});

router.delete('/appointments/:id', (req, res) => {
  const info = db.prepare('DELETE FROM appointments WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Randevu bulunamadı.' });
  res.json({ ok: true });
});

/* --------------------------------- Muayene ---------------------------------- */

router.post('/patients/:id/visits', (req, res) => {
  const patient = db
    .prepare('SELECT id FROM patients WHERE id = ? AND deleted_at IS NULL')
    .get(req.params.id);
  if (!patient) return res.status(404).json({ error: 'Hasta bulunamadı.' });
  const { visit_date, complaint, diagnosis, treatment, weight, temperature, fee } = req.body;
  const info = db
    .prepare(
      `INSERT INTO visits(patient_id, visit_date, complaint, diagnosis, treatment, weight, temperature, fee, vet_user_id)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      patient.id,
      String(visit_date || isoDate()).slice(0, 10),
      complaint || null,
      diagnosis || null,
      treatment || null,
      weight != null && weight !== '' ? Number(weight) : null,
      temperature != null && temperature !== '' ? Number(temperature) : null,
      Number(fee) || 0,
      req.user.id
    );
  // Muayenede tartildiysa hasta kartindaki agirligi da guncelle.
  if (weight) {
    db.prepare("UPDATE patients SET weight = ?, updated_at = datetime('now') WHERE id = ?").run(
      Number(weight),
      patient.id
    );
  }
  audit(req.user.id, 'visit.create', 'patient', patient.id, diagnosis || null);
  res.status(201).json({ id: info.lastInsertRowid });
});

module.exports = router;
