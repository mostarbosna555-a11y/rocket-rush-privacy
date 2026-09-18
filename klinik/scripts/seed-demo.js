'use strict';

/**
 * Deneme verisi yukler: musteriler, hastalar, asi gecmisi ve randevular.
 * Uzerinde calisirken ekranlarin dolu gorunmesi icin.
 *
 *   npm run seed:demo
 */

const { db, nextProtocol } = require('../src/db');
const { isoDate, addDays } = require('../src/util');

const PEOPLE = [
  ['Ali Kasım', '05424056145'],
  ['Zeynep Karslı', '05076976178'],
  ['Mahmut Bedir', '05392364444'],
  ['Celalettin Kaplan', '05360892554'],
  ['Arzu Çalış', '05334707630'],
  ['Bilal Hoş', '05364036073'],
  ['Dilara Tekneyli', '05077328309'],
  ['Faruk Köksal', '05384128150'],
];

const PETS = [
  ['Paşa', 'Kedi', 'British Shorthair', 'Erkek', '2023-11-22'],
  ['Tatlış', 'Kedi', 'Tekir', 'Dişi', '2022-04-10'],
  ['Duman', 'Köpek', 'Golden Retriever', 'Erkek', '2021-06-02'],
  ['Pamuk', 'Kedi', 'Van Kedisi', 'Dişi', '2024-01-15'],
  ['Karamel', 'Köpek', 'Terrier', 'Dişi', '2020-09-30'],
  ['Minnoş', 'Kedi', 'Scottish Fold', 'Dişi', '2023-03-18'],
];

const VACCINES = ['KUDUZ', 'YILLIK KEDİ KARMA', 'İÇ PARAZİT 2 AYLIK', 'DIŞ PARAZİT 2 AYLIK'];

const today = isoDate();

const run = db.transaction(() => {
  for (const [name, gsm] of PEOPLE) {
    const exists = db.prepare('SELECT id FROM customers WHERE full_name = ?').get(name);
    if (exists) continue;

    const cid = db
      .prepare('INSERT INTO customers(protocol_no, full_name, gsm) VALUES(?, ?, ?)')
      .run(nextProtocol('customers'), name, '90' + gsm.slice(1)).lastInsertRowid;

    const petCount = 1 + Math.floor(Math.random() * 2);
    for (let i = 0; i < petCount; i++) {
      const [pname, species, breed, gender, birth] = PETS[Math.floor(Math.random() * PETS.length)];
      const pid = db
        .prepare(
          `INSERT INTO patients(protocol_no, customer_id, name, species, breed, gender, birth_date)
           VALUES(?, ?, ?, ?, ?, ?, ?)`
        )
        .run(nextProtocol('patients'), cid, pname, species, breed, gender, birth).lastInsertRowid;

      // Gecmis asilar + yaklasan/gecikmis dozlar karisik olsun.
      for (const v of VACCINES.slice(0, 2 + Math.floor(Math.random() * 2))) {
        const interval = v.includes('PARAZİT') ? 60 : 365;
        const applied = addDays(today, -interval + Math.floor(Math.random() * 14) - 5);
        db.prepare(
          `INSERT INTO vaccinations(patient_id, vaccine_name, applied_date, status)
           VALUES(?, ?, ?, 'done')`
        ).run(pid, v, applied);
        db.prepare(
          `INSERT INTO vaccinations(patient_id, vaccine_name, due_date, status)
           VALUES(?, ?, ?, 'planned')`
        ).run(pid, v, addDays(applied, interval));
      }

      if (Math.random() > 0.6) {
        db.prepare(
          `INSERT INTO appointments(customer_id, patient_id, starts_at, reason)
           VALUES(?, ?, ?, ?)`
        ).run(cid, pid, `${addDays(today, Math.floor(Math.random() * 5))} 14:30:00`, 'Kontrol');
      }
      db.prepare(
        `INSERT INTO visits(patient_id, visit_date, complaint, diagnosis, fee)
         VALUES(?, ?, 'Rutin kontrol', 'Sağlıklı', ?)`
      ).run(pid, addDays(today, -Math.floor(Math.random() * 200)), 300 + Math.floor(Math.random() * 700));
    }
  }
});

run();

const n = db.prepare('SELECT COUNT(*) AS n FROM customers WHERE deleted_at IS NULL').get().n;
const p = db.prepare('SELECT COUNT(*) AS n FROM patients WHERE deleted_at IS NULL').get().n;
console.log(`[klinik] Deneme verisi hazır: ${n} müşteri, ${p} hasta.`);
