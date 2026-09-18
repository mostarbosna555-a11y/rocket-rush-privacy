'use strict';

const { db, setting } = require('./db');
const { isoDate, addDays, trDate, renderTemplate } = require('./util');
const { clinicVars } = require('./sms');

/**
 * Hatirlatma listesi: belirtilen tarih araliginda vadesi gelen asilar.
 * `sent` alani, ayni asi icin bugun zaten SMS gidip gitmedigini soyler.
 */
function vaccineDue({ from, to, search = '' } = {}) {
  const start = from || isoDate();
  const end = to || addDays(start, Number(setting('reminder_offset_days', '3')));
  const like = `%${search.trim()}%`;

  const rows = db
    .prepare(
      `
    SELECT
      v.id            AS vaccination_id,
      v.vaccine_name,
      v.due_date,
      v.status,
      p.id            AS patient_id,
      p.name          AS patient_name,
      p.species,
      c.id            AS customer_id,
      c.full_name     AS customer_name,
      c.gsm,
      c.email,
      c.allow_sms,
      EXISTS(
        SELECT 1 FROM reminder_sent r
        WHERE r.ref_kind = 'vaccination' AND r.ref_id = v.id
      ) AS sent,
      (SELECT MAX(r2.sent_on) FROM reminder_sent r2
        WHERE r2.ref_kind = 'vaccination' AND r2.ref_id = v.id) AS sent_on
    FROM vaccinations v
    JOIN patients  p ON p.id = v.patient_id AND p.deleted_at IS NULL AND p.deceased = 0
    JOIN customers c ON c.id = p.customer_id AND c.deleted_at IS NULL
    WHERE v.status = 'planned'
      AND v.due_date IS NOT NULL
      AND v.due_date BETWEEN ? AND ?
      AND (? = '' OR c.full_name LIKE ? OR p.name LIKE ? OR c.gsm LIKE ?)
    ORDER BY v.due_date ASC, c.full_name ASC
  `
    )
    .all(start, end, search.trim(), like, like, like);

  return { from: start, to: end, rows };
}

/** Yaklasan randevular. */
function appointmentDue({ from, to, search = '' } = {}) {
  const start = from || isoDate();
  const end = to || addDays(start, 1);
  const like = `%${search.trim()}%`;

  const rows = db
    .prepare(
      `
    SELECT
      a.id AS appointment_id, a.starts_at, a.reason, a.status,
      p.id AS patient_id, p.name AS patient_name,
      c.id AS customer_id, c.full_name AS customer_name, c.gsm, c.email, c.allow_sms,
      EXISTS(SELECT 1 FROM reminder_sent r WHERE r.ref_kind = 'appointment' AND r.ref_id = a.id) AS sent
    FROM appointments a
    LEFT JOIN patients  p ON p.id = a.patient_id
    LEFT JOIN customers c ON c.id = COALESCE(a.customer_id, p.customer_id)
    WHERE a.status = 'planned'
      AND date(a.starts_at) BETWEEN ? AND ?
      AND (? = '' OR c.full_name LIKE ? OR p.name LIKE ?)
    ORDER BY a.starts_at ASC
  `
    )
    .all(start, end, search.trim(), like, like);

  return { from: start, to: end, rows };
}

/** Bugun (veya verilen tarihte) dogum gunu olan hastalar. */
function birthdayDue({ on } = {}) {
  const day = (on || isoDate()).slice(5); // MM-DD
  const rows = db
    .prepare(
      `
    SELECT
      p.id AS patient_id, p.name AS patient_name, p.birth_date, p.species,
      c.id AS customer_id, c.full_name AS customer_name, c.gsm, c.email, c.allow_sms,
      EXISTS(
        SELECT 1 FROM reminder_sent r
        WHERE r.ref_kind = 'birthday' AND r.ref_id = p.id AND r.sent_on LIKE ?
      ) AS sent
    FROM patients p
    JOIN customers c ON c.id = p.customer_id AND c.deleted_at IS NULL
    WHERE p.deleted_at IS NULL AND p.deceased = 0
      AND p.birth_date IS NOT NULL
      AND substr(p.birth_date, 6, 5) = ?
    ORDER BY c.full_name
  `
    )
    .all(`${(on || isoDate()).slice(0, 4)}-%`, day);

  return { on: on || isoDate(), rows };
}

/**
 * Hatirlatma satirini SMS hedefine cevirir (sablon degiskenlerini doldurur).
 * @param {object} row  vaccineDue/appointmentDue/birthdayDue satiri
 * @param {string} body Sablon govdesi
 * @param {string} kind 'vaccination' | 'appointment' | 'birthday'
 */
function toTarget(row, body, kind) {
  const base = clinicVars();
  const vars = {
    ...base,
    musteri: row.customer_name || '',
    hasta: row.patient_name || '',
    asi: row.vaccine_name || '',
    tur: row.species || '',
    telefon: row.gsm || '',
  };

  let refId = null;
  if (kind === 'vaccination') {
    vars.tarih = trDate(row.due_date);
    refId = row.vaccination_id;
  } else if (kind === 'appointment') {
    const dt = String(row.starts_at || '').replace('T', ' ');
    vars.tarih = `${trDate(dt.slice(0, 10))} ${dt.slice(11, 16)}`.trim();
    vars.sebep = row.reason || '';
    refId = row.appointment_id;
  } else {
    vars.tarih = trDate(row.birth_date);
    refId = row.patient_id;
  }

  return {
    gsm: row.gsm,
    name: row.customer_name,
    body: renderTemplate(body, vars),
    customer_id: row.customer_id,
    patient_id: row.patient_id,
    ref_kind: kind,
    ref_id: refId,
  };
}

/** Panelde gosterilen ozet sayilar. */
function dashboard() {
  const today = isoDate();
  const horizon = addDays(today, Number(setting('reminder_offset_days', '3')));
  const q = (sql, ...args) => db.prepare(sql).get(...args).n;

  return {
    customers: q('SELECT COUNT(*) AS n FROM customers WHERE deleted_at IS NULL'),
    patients: q('SELECT COUNT(*) AS n FROM patients WHERE deleted_at IS NULL AND deceased = 0'),
    dueToday: q(
      "SELECT COUNT(*) AS n FROM vaccinations WHERE status = 'planned' AND due_date = ?",
      today
    ),
    dueSoon: q(
      "SELECT COUNT(*) AS n FROM vaccinations WHERE status = 'planned' AND due_date BETWEEN ? AND ?",
      today,
      horizon
    ),
    overdue: q(
      "SELECT COUNT(*) AS n FROM vaccinations WHERE status = 'planned' AND due_date < ?",
      today
    ),
    appointmentsToday: q(
      "SELECT COUNT(*) AS n FROM appointments WHERE status = 'planned' AND date(starts_at) = ?",
      today
    ),
    birthdaysToday: birthdayDue({ on: today }).rows.length,
    smsToday: q('SELECT COUNT(*) AS n FROM sms_log WHERE date(sent_at) = ?', today),
  };
}

module.exports = { vaccineDue, appointmentDue, birthdayDue, toTarget, dashboard };
