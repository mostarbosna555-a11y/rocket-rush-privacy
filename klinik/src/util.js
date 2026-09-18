'use strict';

/**
 * Turk GSM numarasini API'nin bekledigi 90XXXXXXXXXX formatina cevirir.
 * Kabul edilen girdiler: 0542 405 61 45 / +90 542 405 61 45 / 5424056145 / 905424056145
 * Gecersizse null doner.
 */
function normalizeGsm(input) {
  if (!input) return null;
  let d = String(input).replace(/\D/g, '');
  if (d.startsWith('0090')) d = d.slice(4);
  else if (d.startsWith('90') && d.length === 12) d = d.slice(2);
  else if (d.startsWith('0') && d.length === 11) d = d.slice(1);
  if (d.length !== 10) return null;
  if (!d.startsWith('5')) return null; // Turkiye mobil numaralari 5 ile baslar
  return '90' + d;
}

/** Ekranda gosterim icin: +90 542 405 61 45 */
function formatGsm(gsm) {
  const n = normalizeGsm(gsm);
  if (!n) return gsm || '';
  const d = n.slice(2);
  return `+90 ${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6, 8)} ${d.slice(8)}`;
}

// GSM 03.38 temel karakter kumesi. Bunlarin disindaki her sey mesaji unicode yapar.
const GSM7 =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXT = '^{}\\[~]|€';
const GSM7_SET = new Set([...GSM7, ...GSM7_EXT]);

/**
 * Mesajin kac SMS kredisi harcayacagini hesaplar.
 * Turkce karakter (ç, ğ, ı, ş, İ ...) iceren mesaj unicode olur: 70/67 karakter.
 */
function smsInfo(text) {
  const body = String(text || '');
  let unicode = false;
  let length = 0;
  for (const ch of body) {
    if (!GSM7_SET.has(ch)) unicode = true;
    length += GSM7_EXT.includes(ch) ? 2 : 1;
  }
  const single = unicode ? 70 : 160;
  const multi = unicode ? 67 : 153;
  const chars = unicode ? [...body].length : length;
  const segments = chars === 0 ? 0 : chars <= single ? 1 : Math.ceil(chars / multi);
  return { unicode, chars, segments, limit: chars <= single ? single : multi, type: unicode ? 'unicode' : 'sms' };
}

/** {musteri} {hasta} gibi yer tutucularini doldurur. Bilinmeyen yer tutucu bos birakilir. */
function renderTemplate(body, vars) {
  return String(body || '').replace(/\{(\w+)\}/g, (_, key) => {
    const v = vars[key];
    return v == null ? '' : String(v);
  });
}

/** 'YYYY-MM-DD' */
function isoDate(d = new Date()) {
  const tz = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return tz.toISOString().slice(0, 10);
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + Number(days || 0));
  return isoDate(d);
}

const TR_MONTHS = [
  'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
  'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık',
];

/** '2026-09-17' -> '17 Eylül 2026' */
function trDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return dateStr;
  return `${d} ${TR_MONTHS[m - 1]} ${y}`;
}

/** Dogum tarihinden '2 yıl, 9 ay, 26 gün' uretir. */
function ageText(birthDate, now = new Date()) {
  if (!birthDate) return '';
  const b = new Date(`${String(birthDate).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(b.getTime()) || b > now) return '';
  let years = now.getFullYear() - b.getFullYear();
  let months = now.getMonth() - b.getMonth();
  let days = now.getDate() - b.getDate();
  if (days < 0) {
    months -= 1;
    days += new Date(now.getFullYear(), now.getMonth(), 0).getDate();
  }
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  const parts = [];
  if (years) parts.push(`${years} yıl`);
  if (months) parts.push(`${months} ay`);
  parts.push(`${days} gün`);
  return parts.join(', ');
}

/** Yasa gore kaba yas grubu. */
function ageGroup(birthDate, now = new Date()) {
  if (!birthDate) return null;
  const b = new Date(`${String(birthDate).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(b.getTime())) return null;
  const months = (now.getFullYear() - b.getFullYear()) * 12 + (now.getMonth() - b.getMonth());
  if (months < 12) return 'Yavru';
  if (months < 84) return 'Adult';
  return 'Yaşlı';
}

module.exports = {
  normalizeGsm,
  formatGsm,
  smsInfo,
  renderTemplate,
  isoDate,
  addDays,
  trDate,
  ageText,
  ageGroup,
};
