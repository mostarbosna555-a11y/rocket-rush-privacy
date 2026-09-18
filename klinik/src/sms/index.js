'use strict';

const crypto = require('crypto');
const { db, setting, audit } = require('../db');
const { normalizeGsm, smsInfo, renderTemplate } = require('../util');
const { OrganikClient, OrganikError } = require('./organik');

/**
 * Gonderim katmani.
 *
 * Kurallar:
 *  - Kara listedeki numaraya SMS gitmez.
 *  - allow_sms = 0 olan musteriye SMS gitmez (KVKK / izin).
 *  - Ayni govde metnine sahip alicilar tek API cagrisinda gruplanir (kredi/istek tasarrufu).
 *  - Her alici icin sms_log'a bir satir yazilir.
 */

function currentProvider() {
  return setting('sms_provider', 'mock');
}

function getClient() {
  const provider = currentProvider();
  if (provider !== 'organik') return null;
  const key = setting('sms_api_key', '');
  return new OrganikClient(key);
}

function isBlacklisted(gsm) {
  return !!db.prepare('SELECT 1 FROM blacklist WHERE gsm = ?').get(gsm);
}

/** Ayarlardaki ve klinige ait ortak degiskenler. */
function clinicVars() {
  return {
    klinik: setting('clinic_name', 'Kliniğim'),
    klinik_tel: setting('clinic_phone', ''),
  };
}

/**
 * @typedef {object} Target
 * @property {string}  gsm          Ham veya normalize numara
 * @property {string}  body         Gonderilecek metin (yer tutucular cozulmus)
 * @property {number} [customer_id]
 * @property {number} [patient_id]
 * @property {string} [ref_kind]    'vaccination' | 'appointment' | 'birthday' — tekrar gonderimi engellemek icin
 * @property {number} [ref_id]
 */

/**
 * Hedef listesini dogrular, elenenleri gerekcesiyle birlikte geri verir.
 * @returns {{ ok: Target[], skipped: Array<{gsm: string, reason: string, name?: string}> }}
 */
function prepareTargets(targets) {
  const ok = [];
  const skipped = [];
  const seen = new Set();

  for (const t of targets) {
    const gsm = normalizeGsm(t.gsm);
    const name = t.name || '';
    if (!gsm) {
      skipped.push({ gsm: t.gsm || '', name, reason: 'Geçersiz GSM numarası' });
      continue;
    }
    if (isBlacklisted(gsm)) {
      skipped.push({ gsm, name, reason: 'Kara listede' });
      continue;
    }
    if (t.customer_id) {
      const c = db.prepare('SELECT allow_sms FROM customers WHERE id = ?').get(t.customer_id);
      if (c && !c.allow_sms) {
        skipped.push({ gsm, name, reason: 'SMS izni kapalı' });
        continue;
      }
    }
    if (!t.body || !t.body.trim()) {
      skipped.push({ gsm, name, reason: 'Boş mesaj' });
      continue;
    }
    const dedupeKey = `${gsm}|${t.body}`;
    if (seen.has(dedupeKey)) {
      skipped.push({ gsm, name, reason: 'Aynı mesaj listede tekrar ediyor' });
      continue;
    }
    seen.add(dedupeKey);
    ok.push({ ...t, gsm });
  }
  return { ok, skipped };
}

/** Gonderim oncesi maliyet ozeti — kullaniciya "kaç kredi gidecek" demek icin. */
function estimate(targets) {
  const { ok, skipped } = prepareTargets(targets);
  let segments = 0;
  let unicode = false;
  for (const t of ok) {
    const info = smsInfo(t.body);
    segments += info.segments;
    if (info.unicode) unicode = true;
  }
  return { recipients: ok.length, segments, unicode, skipped };
}

/**
 * Asil gonderim.
 * @param {Target[]} targets
 * @param {object} opts
 * @param {string}  opts.kind        'asi' | 'randevu' | 'dogumgunu' | 'genel'
 * @param {boolean} opts.commercial  Ticari (pazarlama) gonderimi mi
 * @param {string}  opts.recipientType 'BIREYSEL' | 'TACIR'
 * @param {number}  opts.userId
 * @param {boolean} opts.dryRun      true ise API cagrilmaz, sadece hesaplanir
 */
async function send(targets, opts = {}) {
  const {
    kind = 'genel',
    commercial = false,
    recipientType = 'BIREYSEL',
    userId = null,
    dryRun = false,
  } = opts;

  const { ok, skipped } = prepareTargets(targets);
  const batchId = crypto.randomUUID();
  const provider = currentProvider();
  const today = new Date().toISOString().slice(0, 10);

  if (ok.length === 0) {
    return { batchId, provider, sent: 0, failed: 0, segments: 0, skipped, groups: [] };
  }

  if (dryRun) {
    const est = estimate(targets);
    return { batchId, provider, dryRun: true, ...est, sent: 0, failed: 0, groups: [] };
  }

  // Ayni metni paylasan alicilari grupla: tek API cagrisi, cok alici.
  const groups = new Map();
  for (const t of ok) {
    if (!groups.has(t.body)) groups.set(t.body, []);
    groups.get(t.body).push(t);
  }

  const headerId = setting('sms_header_id', '');
  let client = null;
  if (provider === 'organik') {
    if (!headerId) {
      throw new OrganikError(
        'SMS başlığı seçilmemiş. Ayarlar > SMS bölümünden onaylı başlığınızı seçin.',
        'no_header'
      );
    }
    client = getClient();
  }

  const insLog = db.prepare(`
    INSERT INTO sms_log(customer_id, patient_id, gsm, body, kind, provider, provider_tx, status, error, segments, batch_id)
    VALUES(@customer_id, @patient_id, @gsm, @body, @kind, @provider, @provider_tx, @status, @error, @segments, @batch_id)
  `);
  const insReminder = db.prepare(`
    INSERT OR IGNORE INTO reminder_sent(ref_kind, ref_id, sent_on, sms_log_id) VALUES(?, ?, ?, ?)
  `);

  let sent = 0;
  let failed = 0;
  let segments = 0;
  const results = [];

  for (const [body, members] of groups) {
    const info = smsInfo(body);
    let txId = null;
    let status = 'sent';
    let error = null;

    try {
      if (provider === 'organik') {
        const data = await client.sendSms({
          message: body,
          recipients: members.map((m) => m.gsm),
          header: headerId,
          commercial,
          recipientType,
          type: info.unicode ? 'turkish' : 'sms',
        });
        txId = data?.id != null ? String(data.id) : null;
      } else {
        // mock: gercek gonderim yok, sadece kayit.
        txId = `mock-${batchId.slice(0, 8)}`;
      }
    } catch (err) {
      status = 'failed';
      error = err instanceof OrganikError ? err.message : String(err.message || err);
    }

    const writeGroup = db.transaction(() => {
      for (const m of members) {
        const res = insLog.run({
          customer_id: m.customer_id ?? null,
          patient_id: m.patient_id ?? null,
          gsm: m.gsm,
          body,
          kind,
          provider,
          provider_tx: txId,
          status,
          error,
          segments: info.segments,
          batch_id: batchId,
        });
        if (status === 'sent' && m.ref_kind && m.ref_id) {
          insReminder.run(m.ref_kind, m.ref_id, today, res.lastInsertRowid);
        }
      }
    });
    writeGroup();

    if (status === 'sent') {
      sent += members.length;
      segments += info.segments * members.length;
    } else {
      failed += members.length;
    }
    results.push({ body, count: members.length, status, error, tx: txId });
  }

  audit(
    userId,
    'sms.send',
    'sms_batch',
    null,
    JSON.stringify({ batchId, kind, provider, sent, failed, segments })
  );

  return { batchId, provider, sent, failed, segments, skipped, groups: results };
}

/** Bakiye — mock saglayicida null doner. */
async function balance() {
  if (currentProvider() !== 'organik') return null;
  return getClient().balance();
}

/** Onayli basliklar — ayarlar ekraninda secim icin. */
async function headers() {
  if (currentProvider() !== 'organik') return [];
  return getClient().headers();
}

module.exports = {
  send,
  estimate,
  prepareTargets,
  balance,
  headers,
  clinicVars,
  currentProvider,
  getClient,
  renderTemplate,
  smsInfo,
  OrganikError,
};
