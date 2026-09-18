'use strict';

/**
 * Uctan uca duman testi: sunucuyu ayaga kaldirir, ana akisi (musteri -> hasta ->
 * asi -> hatirlatma -> SMS -> gecmis) mock saglayici ile calistirir.
 *
 *   node scripts/smoke.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'klinik-smoke-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.ADMIN_PASSWORD = 'test1234';

const app = require('../server');
const { isoDate, addDays } = require('../src/util');

let base;
let cookie = '';
let failures = 0;

async function call(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function step(name, fn) {
  try {
    await fn();
    console.log('  \x1b[32m✓\x1b[0m', name);
  } catch (err) {
    failures++;
    console.log('  \x1b[31m✗\x1b[0m', name, '\n     ', err.message);
  }
}

(async function run() {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  console.log('Duman testi başlıyor:', base, '\n');

  let customerId, patientId, vaccinationId;

  await step('Yanlış şifre reddedilir', async () => {
    const r = await call('POST', '/api/login', { username: 'admin', password: 'yanlis' });
    assert.strictEqual(r.status, 401);
  });

  await step('Oturum açılır', async () => {
    const r = await call('POST', '/api/login', { username: 'admin', password: 'test1234' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.role, 'admin');
  });

  await step('Oturumsuz istek 401 döner', async () => {
    const res = await fetch(base + '/api/customers');
    assert.strictEqual(res.status, 401);
  });

  await step('Geçersiz GSM reddedilir', async () => {
    const r = await call('POST', '/api/customers', { full_name: 'Hatalı', gsm: '123' });
    assert.strictEqual(r.status, 400);
  });

  await step('Müşteri eklenir ve GSM normalize edilir', async () => {
    const r = await call('POST', '/api/customers', {
      full_name: 'Ali Kasım',
      gsm: '0542 405 61 45',
      identity_no: '22385658324',
    });
    assert.strictEqual(r.status, 201);
    customerId = r.data.id;
    const c = await call('GET', '/api/customers/' + customerId);
    assert.strictEqual(c.data.gsm, '905424056145');
    assert.strictEqual(c.data.protocol_no, 1);
  });

  await step('Hasta eklenir, yaş hesaplanır', async () => {
    const r = await call('POST', '/api/patients', {
      customer_id: customerId,
      name: 'Paşa',
      species: 'Kedi',
      breed: 'British Shorthair',
      gender: 'Erkek',
      birth_date: '2023-11-22',
    });
    assert.strictEqual(r.status, 201);
    patientId = r.data.id;
    const p = await call('GET', '/api/patients/' + patientId);
    assert.match(p.data.age_text, /yıl/);
  });

  await step('Aşı yapıldı kaydı bir sonraki dozu planlar', async () => {
    const applied = addDays(isoDate(), -360);
    const r = await call('POST', `/api/patients/${patientId}/vaccinations`, {
      vaccine_name: 'KUDUZ',
      applied_date: applied,
    });
    assert.strictEqual(r.status, 201);
    assert.ok(r.data.nextId, 'sonraki doz planlanmadı');
    const p = await call('GET', '/api/patients/' + patientId);
    const planned = p.data.vaccinations.find((v) => v.status === 'planned');
    assert.strictEqual(planned.due_date, addDays(applied, 365));
    vaccinationId = planned.id;
  });

  await step('Hatırlatma listesi yaklaşan aşıyı gösterir', async () => {
    const r = await call('GET', `/api/reminders/vaccines?from=1900-01-01&to=2999-12-31`);
    const row = r.data.rows.find((x) => x.vaccination_id === vaccinationId);
    assert.ok(row, 'aşı hatırlatma listesinde yok');
    assert.strictEqual(row.customer_name, 'Ali Kasım');
    assert.strictEqual(Number(row.sent), 0);
  });

  await step('Önizleme (dry run) gerçek gönderim yapmaz', async () => {
    const r = await call('POST', '/api/reminders/send', {
      kind: 'vaccination',
      ids: [vaccinationId],
      body: 'Sayın {musteri}, {hasta} için {asi} aşı zamanı ({tarih}).',
      dry_run: true,
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.recipients, 1);
    assert.strictEqual(r.data.sent, 0);
    const h = await call('GET', '/api/sms/history');
    assert.strictEqual(h.data.totals.total, 0, 'dry run kayıt oluşturmuş');
  });

  await step('Hatırlatma SMS gönderilir ve şablon doldurulur', async () => {
    const r = await call('POST', '/api/reminders/send', {
      kind: 'vaccination',
      ids: [vaccinationId],
      body: 'Sayın {musteri}, {hasta} için {asi} aşı zamanı ({tarih}).',
    });
    assert.strictEqual(r.data.sent, 1, JSON.stringify(r.data));
    const h = await call('GET', '/api/sms/history');
    const log = h.data.rows[0];
    assert.match(log.body, /Sayın Ali Kasım, Paşa için KUDUZ aşı zamanı/);
    assert.strictEqual(log.gsm, '905424056145');
    assert.strictEqual(log.status, 'sent');
  });

  await step('Gönderilen hatırlatma listede işaretlenir', async () => {
    const r = await call('GET', `/api/reminders/vaccines?from=1900-01-01&to=2999-12-31`);
    const row = r.data.rows.find((x) => x.vaccination_id === vaccinationId);
    assert.strictEqual(Number(row.sent), 1);
  });

  await step('Kara listedeki numaraya SMS gitmez', async () => {
    await call('POST', '/api/blacklist', { gsm: '0542 405 61 45', reason: 'test' });
    const r = await call('POST', '/api/sms/single', { customer_id: customerId, body: 'Deneme' });
    assert.strictEqual(r.data.sent, 0);
    assert.strictEqual(r.data.skipped[0].reason, 'Kara listede');
    const bl = await call('GET', '/api/blacklist');
    await call('DELETE', '/api/blacklist/' + bl.data[0].id);
  });

  await step('SMS izni kapalı müşteriye gönderim yapılmaz', async () => {
    await call('PUT', '/api/customers/' + customerId, { allow_sms: false });
    const r = await call('POST', '/api/sms/single', { customer_id: customerId, body: 'Deneme' });
    assert.strictEqual(r.data.sent, 0);
    assert.strictEqual(r.data.skipped[0].reason, 'SMS izni kapalı');
    await call('PUT', '/api/customers/' + customerId, { allow_sms: true });
  });

  await step('Aynı metin tek API çağrısında gruplanır', async () => {
    const r2 = await call('POST', '/api/customers', { full_name: 'Zeynep Karslı', gsm: '05076976178' });
    const r = await call('POST', '/api/bulk/send', {
      body: 'Kliniğimiz bayramda açıktır.',
      customer_ids: [customerId, r2.data.id],
    });
    assert.strictEqual(r.data.sent, 2);
    assert.strictEqual(r.data.groups.length, 1, 'aynı metin gruplanmadı');
  });

  await step('Kişiselleştirilmiş toplu mesaj ayrı gruplara bölünür', async () => {
    const r = await call('GET', '/api/bulk/audience?kind=all');
    const ids = r.data.rows.map((x) => x.customer_id);
    const s = await call('POST', '/api/bulk/send', { body: 'Sayın {musteri}, merhaba.', customer_ids: ids });
    assert.strictEqual(s.data.groups.length, ids.length);
  });

  await step('Türkçe karakterli mesaj doğru kredi hesaplar', async () => {
    const r = await call('POST', '/api/sms/preview', { body: 'Sayın {musteri}, aşı zamanı geldi.' });
    assert.strictEqual(r.data.unicode, true);
    assert.strictEqual(r.data.segments, 1);
    const long = await call('POST', '/api/sms/preview', { body: 'ş'.repeat(100) });
    assert.strictEqual(long.data.segments, 2);
    const ascii = await call('POST', '/api/sms/preview', { body: 'A'.repeat(100) });
    assert.strictEqual(ascii.data.unicode, false);
    assert.strictEqual(ascii.data.segments, 1);
  });

  await step('Planlanan aşı "yapıldı" yapılınca yeni doz açılır', async () => {
    const r = await call('POST', `/api/vaccinations/${vaccinationId}/complete`, {});
    assert.strictEqual(r.status, 200);
    assert.ok(r.data.nextId);
    const p = await call('GET', '/api/patients/' + patientId);
    assert.strictEqual(p.data.vaccinations.filter((v) => v.status === 'planned').length, 1);
  });

  await step('Randevu eklenir ve listelenir', async () => {
    const when = `${addDays(isoDate(), 1)} 14:30:00`;
    const r = await call('POST', '/api/appointments', {
      customer_id: customerId, patient_id: patientId, starts_at: when, reason: 'Kontrol',
    });
    assert.strictEqual(r.status, 201);
    const list = await call('GET', `/api/appointments?from=${isoDate()}&to=${addDays(isoDate(), 7)}`);
    assert.ok(list.data.rows.some((a) => a.reason === 'Kontrol'));
  });

  await step('API anahtarı istemciye maskelenerek döner', async () => {
    await call('PUT', '/api/settings', { sms_api_key: 'super-gizli-anahtar-1234' });
    const s = await call('GET', '/api/settings');
    assert.ok(s.data.sms_api_key.startsWith('••••'));
    assert.ok(!s.data.sms_api_key.includes('super-gizli'));
    // Maskeli deger geri gonderilince anahtar bozulmamali.
    await call('PUT', '/api/settings', { sms_api_key: s.data.sms_api_key });
    const again = await call('GET', '/api/settings');
    assert.strictEqual(again.data.sms_api_key, '••••1234');
  });

  await step('Organik sağlayıcı seçiliyken başlıksız gönderim engellenir', async () => {
    await call('PUT', '/api/settings', { sms_provider: 'organik', sms_header_id: '' });
    const r = await call('POST', '/api/sms/single', { customer_id: customerId, body: 'Test' });
    assert.strictEqual(r.status, 502);
    assert.match(r.data.error, /SMS başlığı seçilmemiş/);
    await call('PUT', '/api/settings', { sms_provider: 'mock' });
  });

  await step('Müşteri silinince hastaları da pasifleşir', async () => {
    await call('DELETE', '/api/customers/' + customerId);
    const c = await call('GET', '/api/customers/' + customerId);
    assert.strictEqual(c.status, 404);
    const p = await call('GET', '/api/patients/' + patientId);
    assert.strictEqual(p.status, 404);
    // SMS gecmisi korunur (yasal kayit).
    const h = await call('GET', '/api/sms/history');
    assert.ok(h.data.totals.total > 0);
  });

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? '\n\x1b[32mTüm testler geçti.\x1b[0m' : `\n\x1b[31m${failures} test başarısız.\x1b[0m`);
  process.exit(failures === 0 ? 0 : 1);
})();
