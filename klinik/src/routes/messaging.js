'use strict';

/** Hatirlatma listesi, toplu SMS, sablonlar, kara liste ve gonderim gecmisi. */

const express = require('express');
const { db, setting, audit } = require('../db');
const { normalizeGsm, smsInfo, renderTemplate, isoDate, addDays } = require('../util');
const sms = require('../sms');
const reminders = require('../reminders');

const router = express.Router();

/* ------------------------------ Hatirlatmalar ------------------------------- */

router.get('/reminders/vaccines', (req, res) => {
  res.json(
    reminders.vaccineDue({
      from: req.query.from,
      to: req.query.to,
      search: String(req.query.q || ''),
    })
  );
});

router.get('/reminders/appointments', (req, res) => {
  res.json(
    reminders.appointmentDue({
      from: req.query.from,
      to: req.query.to,
      search: String(req.query.q || ''),
    })
  );
});

router.get('/reminders/birthdays', (req, res) => {
  res.json(reminders.birthdayDue({ on: req.query.on }));
});

/**
 * Hatirlatma listesinden secilen satirlara SMS gonderir.
 * body: { kind: 'vaccination'|'appointment'|'birthday', ids: number[], template_id?, body?, dry_run? }
 */
router.post('/reminders/send', async (req, res, next) => {
  try {
    const { kind = 'vaccination', ids = [], template_id, body: rawBody, dry_run = false } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'Hiç kayıt seçilmedi.' });
    }

    let template = rawBody;
    if (!template && template_id) {
      const t = db.prepare('SELECT body FROM sms_templates WHERE id = ?').get(template_id);
      if (!t) return res.status(400).json({ error: 'Şablon bulunamadı.' });
      template = t.body;
    }
    if (!template || !template.trim()) {
      return res.status(400).json({ error: 'Mesaj şablonu seçilmedi.' });
    }

    // Genis bir aralikta arayip secilen id'leri filtreliyoruz; boylece
    // istemci hangi tarih filtresinde olursa olsun satir bilgisi tutarli gelir.
    const wide = { from: '1900-01-01', to: '2999-12-31' };
    let rows;
    if (kind === 'vaccination') {
      rows = reminders.vaccineDue(wide).rows.filter((r) => ids.includes(r.vaccination_id));
    } else if (kind === 'appointment') {
      rows = reminders.appointmentDue(wide).rows.filter((r) => ids.includes(r.appointment_id));
    } else {
      rows = db
        .prepare(
          `SELECT p.id AS patient_id, p.name AS patient_name, p.birth_date, p.species,
                  c.id AS customer_id, c.full_name AS customer_name, c.gsm
             FROM patients p JOIN customers c ON c.id = p.customer_id
            WHERE p.id IN (${ids.map(() => '?').join(',')}) AND p.deleted_at IS NULL`
        )
        .all(...ids);
    }

    if (rows.length === 0) return res.status(400).json({ error: 'Seçilen kayıtlar bulunamadı.' });

    const kindMap = { vaccination: 'asi', appointment: 'randevu', birthday: 'dogumgunu' };
    const targets = rows.map((r) => reminders.toTarget(r, template, kind));
    const result = await sms.send(targets, {
      kind: kindMap[kind] || 'genel',
      commercial: false, // hatirlatma = hizmet/bilgilendirme mesaji, ticari degil
      userId: req.user.id,
      dryRun: !!dry_run,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/* -------------------------------- Toplu SMS --------------------------------- */

/** Toplu gonderim icin alici havuzlari. */
function audience(kind, opts = {}) {
  if (kind === 'debtors') {
    return db
      .prepare(
        `SELECT id AS customer_id, full_name AS name, gsm, balance
           FROM customers WHERE deleted_at IS NULL AND gsm IS NOT NULL AND balance > 0
          ORDER BY full_name COLLATE NOCASE`
      )
      .all();
  }
  if (kind === 'species') {
    return db
      .prepare(
        `SELECT DISTINCT c.id AS customer_id, c.full_name AS name, c.gsm
           FROM customers c JOIN patients p ON p.customer_id = c.id
          WHERE c.deleted_at IS NULL AND p.deleted_at IS NULL AND c.gsm IS NOT NULL
            AND p.species = ?
          ORDER BY c.full_name COLLATE NOCASE`
      )
      .all(opts.species || 'Kedi');
  }
  if (kind === 'inactive') {
    // Belirtilen gun sayisidir klinige gelmemis musteriler.
    const since = addDays(isoDate(), -Math.abs(Number(opts.days) || 365));
    return db
      .prepare(
        `SELECT c.id AS customer_id, c.full_name AS name, c.gsm
           FROM customers c
          WHERE c.deleted_at IS NULL AND c.gsm IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM visits v JOIN patients p ON p.id = v.patient_id
               WHERE p.customer_id = c.id AND v.visit_date >= ?
            )
          ORDER BY c.full_name COLLATE NOCASE`
      )
      .all(since);
  }
  return db
    .prepare(
      `SELECT id AS customer_id, full_name AS name, gsm, balance
         FROM customers WHERE deleted_at IS NULL AND gsm IS NOT NULL
        ORDER BY full_name COLLATE NOCASE`
    )
    .all();
}

router.get('/bulk/audience', (req, res) => {
  const rows = audience(String(req.query.kind || 'all'), {
    species: req.query.species,
    days: req.query.days,
  });
  res.json({ count: rows.length, rows });
});

/**
 * Toplu SMS gonderimi.
 * body: { body, customer_ids?: number[], audience?, manual?: string[], commercial, recipient_type, dry_run }
 */
router.post('/bulk/send', async (req, res, next) => {
  try {
    const {
      body: rawBody,
      template_id,
      customer_ids,
      audience: audienceKind,
      audience_opts = {},
      manual = [],
      commercial = false,
      recipient_type = 'BIREYSEL',
      dry_run = false,
    } = req.body;

    let template = rawBody;
    if (!template && template_id) {
      const t = db.prepare('SELECT body FROM sms_templates WHERE id = ?').get(template_id);
      template = t?.body;
    }
    if (!template || !template.trim()) return res.status(400).json({ error: 'Mesaj boş olamaz.' });

    const targets = [];
    const vars = sms.clinicVars();

    if (Array.isArray(customer_ids) && customer_ids.length) {
      const rows = db
        .prepare(
          `SELECT id AS customer_id, full_name AS name, gsm, balance
             FROM customers
            WHERE deleted_at IS NULL AND id IN (${customer_ids.map(() => '?').join(',')})`
        )
        .all(...customer_ids);
      for (const r of rows) {
        targets.push({
          ...r,
          body: renderTemplate(template, { ...vars, musteri: r.name, bakiye: r.balance ?? 0, hasta: '' }),
        });
      }
    } else if (audienceKind) {
      for (const r of audience(audienceKind, audience_opts)) {
        targets.push({
          ...r,
          body: renderTemplate(template, { ...vars, musteri: r.name, bakiye: r.balance ?? 0, hasta: '' }),
        });
      }
    }

    for (const raw of manual) {
      targets.push({
        gsm: raw,
        name: '',
        body: renderTemplate(template, { ...vars, musteri: '', hasta: '', bakiye: '' }),
      });
    }

    if (targets.length === 0) return res.status(400).json({ error: 'Alıcı listesi boş.' });

    const result = await sms.send(targets, {
      kind: 'genel',
      commercial: !!commercial,
      recipientType: recipient_type,
      userId: req.user.id,
      dryRun: !!dry_run,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/** Tek bir musteriye serbest SMS (musteri kartindaki "Sms" dugmesi). */
router.post('/sms/single', async (req, res, next) => {
  try {
    const { customer_id, patient_id, body: text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'Mesaj boş olamaz.' });
    const c = db
      .prepare('SELECT id, full_name, gsm FROM customers WHERE id = ? AND deleted_at IS NULL')
      .get(customer_id);
    if (!c) return res.status(404).json({ error: 'Müşteri bulunamadı.' });
    if (!c.gsm) return res.status(400).json({ error: 'Müşterinin GSM numarası kayıtlı değil.' });

    const patient = patient_id
      ? db.prepare('SELECT name FROM patients WHERE id = ?').get(patient_id)
      : null;
    const rendered = renderTemplate(text, {
      ...sms.clinicVars(),
      musteri: c.full_name,
      hasta: patient?.name || '',
    });

    const result = await sms.send(
      [{ gsm: c.gsm, name: c.full_name, body: rendered, customer_id: c.id, patient_id: patient_id || null }],
      { kind: 'genel', commercial: false, userId: req.user.id }
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/** Gonderim oncesi karakter/kredi hesabi — ekranda "Sms Mesajı: 0/1" gostergesi. */
router.post('/sms/preview', (req, res) => {
  const text = String(req.body.body || '');
  const sample = req.body.customer_id
    ? db.prepare('SELECT full_name FROM customers WHERE id = ?').get(req.body.customer_id)
    : null;
  const rendered = renderTemplate(text, {
    ...sms.clinicVars(),
    musteri: sample?.full_name || 'Örnek Müşteri',
    hasta: 'Pamuk',
    asi: 'KUDUZ',
    tarih: '17 Eylül 2026',
    bakiye: '0',
  });
  res.json({ rendered, ...smsInfo(rendered) });
});

/* -------------------------------- Sablonlar --------------------------------- */

router.get('/templates', (_req, res) => {
  res.json(db.prepare('SELECT * FROM sms_templates ORDER BY kind, name').all());
});

router.post('/templates', (req, res) => {
  const { name, kind = 'genel', body } = req.body;
  if (!name || !body) return res.status(400).json({ error: 'Şablon adı ve içeriği zorunludur.' });
  try {
    const info = db
      .prepare('INSERT INTO sms_templates(name, kind, body) VALUES(?, ?, ?)')
      .run(String(name).trim(), kind, body);
    res.status(201).json({ id: info.lastInsertRowid });
  } catch {
    res.status(409).json({ error: 'Bu isimde bir şablon zaten var.' });
  }
});

router.put('/templates/:id', (req, res) => {
  const { name, kind, body } = req.body;
  const info = db
    .prepare(
      `UPDATE sms_templates
          SET name = COALESCE(?, name), kind = COALESCE(?, kind), body = COALESCE(?, body)
        WHERE id = ?`
    )
    .run(name || null, kind || null, body || null, req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Şablon bulunamadı.' });
  res.json({ ok: true });
});

router.delete('/templates/:id', (req, res) => {
  const info = db.prepare('DELETE FROM sms_templates WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Şablon bulunamadı.' });
  res.json({ ok: true });
});

/* -------------------------------- Kara liste -------------------------------- */

router.get('/blacklist', (_req, res) => {
  res.json(db.prepare('SELECT * FROM blacklist ORDER BY created_at DESC').all());
});

router.post('/blacklist', (req, res) => {
  const gsm = normalizeGsm(req.body.gsm);
  if (!gsm) return res.status(400).json({ error: 'Geçersiz GSM numarası.' });
  db.prepare(
    'INSERT INTO blacklist(gsm, reason) VALUES(?, ?) ON CONFLICT(gsm) DO UPDATE SET reason = excluded.reason'
  ).run(gsm, req.body.reason || null);
  audit(req.user.id, 'blacklist.add', null, null, gsm);
  res.status(201).json({ ok: true, gsm });
});

router.delete('/blacklist/:id', (req, res) => {
  const info = db.prepare('DELETE FROM blacklist WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Kayıt bulunamadı.' });
  audit(req.user.id, 'blacklist.remove', null, Number(req.params.id), null);
  res.json({ ok: true });
});

/* ------------------------------ Gonderim gecmisi ---------------------------- */

router.get('/sms/history', (req, res) => {
  const from = req.query.from || addDays(isoDate(), -30);
  const to = req.query.to || isoDate();
  const q = String(req.query.q || '').trim();
  const like = `%${q}%`;
  const rows = db
    .prepare(
      `SELECT l.*, c.full_name AS customer_name, p.name AS patient_name
         FROM sms_log l
         LEFT JOIN customers c ON c.id = l.customer_id
         LEFT JOIN patients  p ON p.id = l.patient_id
        WHERE date(l.sent_at) BETWEEN ? AND ?
          AND (? = '' OR c.full_name LIKE ? OR l.gsm LIKE ? OR l.body LIKE ?)
        ORDER BY l.sent_at DESC LIMIT 1000`
    )
    .all(from, to, q, like, like, like);

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'sent'   THEN 1 ELSE 0 END) AS sent,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
              COALESCE(SUM(segments), 0) AS segments
         FROM sms_log WHERE date(sent_at) BETWEEN ? AND ?`
    )
    .get(from, to);

  res.json({ from, to, totals, rows });
});

/** Organik tarafindaki teslimat durumunu tazeler. */
router.post('/sms/history/refresh/:batchId', async (req, res, next) => {
  try {
    if (sms.currentProvider() !== 'organik') {
      return res.status(400).json({ error: 'Aktif sağlayıcı Organik Haberleşme değil.' });
    }
    const txs = db
      .prepare('SELECT DISTINCT provider_tx FROM sms_log WHERE batch_id = ? AND provider_tx IS NOT NULL')
      .all(req.params.batchId)
      .map((r) => r.provider_tx);
    const client = sms.getClient();
    const out = [];
    for (const tx of txs) out.push(await client.reportDetail(tx));
    res.json({ reports: out });
  } catch (err) {
    next(err);
  }
});

/* --------------------------------- Bakiye ----------------------------------- */

router.get('/sms/balance', async (_req, res, next) => {
  try {
    const provider = sms.currentProvider();
    if (provider !== 'organik') return res.json({ provider, balance: null });
    res.json({ provider, balance: await sms.balance() });
  } catch (err) {
    next(err);
  }
});

router.get('/sms/headers', async (_req, res, next) => {
  try {
    res.json(await sms.headers());
  } catch (err) {
    next(err);
  }
});

module.exports = router;
