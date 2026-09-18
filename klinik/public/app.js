'use strict';

/* ============================== Yardımcılar ============================== */

const $ = (sel, root = document) => root.querySelector(sel);
const el = (id) => document.getElementById(id);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    state.user = null;
    renderAuth();
    throw new Error('Oturum sona erdi.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `İstek başarısız (${res.status}).`);
  return data;
}

function toast(msg, kind = '') {
  const node = document.createElement('div');
  node.className = 'toast ' + kind;
  node.textContent = msg;
  el('toasts').appendChild(node);
  setTimeout(() => node.remove(), 5200);
}

function openModal(title, html) {
  el('modalTitle').textContent = title;
  el('modalBody').innerHTML = html;
  el('modal').classList.remove('hidden');
}
function closeModal() {
  el('modal').classList.add('hidden');
  el('modalBody').innerHTML = '';
}
el('modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal' || e.target.dataset.close !== undefined) closeModal();
});

const TR_MONTHS = ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];
function trDate(s) {
  if (!s) return '';
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return s;
  return `${d} ${TR_MONTHS[m - 1]} ${y}`;
}
function trDateTime(s) {
  if (!s) return '';
  const str = String(s).replace('T', ' ');
  return `${trDate(str.slice(0, 10))} ${str.slice(11, 16)}`;
}
function today() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function fmtGsm(g) {
  const d = String(g || '').replace(/\D/g, '');
  if (d.length !== 12) return g || '';
  const n = d.slice(2);
  return `0${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6, 8)} ${n.slice(8)}`;
}

/** SMS kredi hesabı — sunucudaki util.smsInfo ile aynı kuralları uygular. */
const GSM7 = new Set([
  ...'@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
  ...'^{}\\[~]|€',
]);
function smsInfo(text) {
  const body = String(text || '');
  let unicode = false;
  for (const ch of body) if (!GSM7.has(ch)) { unicode = true; break; }
  const chars = [...body].length;
  const single = unicode ? 70 : 160;
  const multi = unicode ? 67 : 153;
  const segments = chars === 0 ? 0 : chars <= single ? 1 : Math.ceil(chars / multi);
  return { unicode, chars, segments, limit: chars <= single ? single : multi };
}

/** Mesaj kutusuna canlı karakter/kredi sayacı bağlar. */
function bindCounter(textarea, counter) {
  const upd = () => {
    const i = smsInfo(textarea.value);
    counter.textContent = `${i.chars} karakter · ${i.segments} SMS kredisi${i.unicode ? ' (Türkçe karakter)' : ''}`;
    counter.classList.toggle('over', i.segments > 1);
  };
  textarea.addEventListener('input', upd);
  upd();
}

const PLACEHOLDERS = ['musteri', 'hasta', 'asi', 'tarih', 'klinik', 'klinik_tel', 'bakiye'];
function placeholderBar(targetId) {
  return `<div class="hint">Yer tutucular: ${PLACEHOLDERS.map(
    (p) => `<code class="ph" data-ph="${p}" data-target="${targetId}">{${p}}</code>`
  ).join(' ')}</div>`;
}
document.addEventListener('click', (e) => {
  const ph = e.target.closest('.ph');
  if (!ph) return;
  const ta = el(ph.dataset.target);
  if (!ta) return;
  const tag = `{${ph.dataset.ph}}`;
  const pos = ta.selectionStart ?? ta.value.length;
  ta.value = ta.value.slice(0, pos) + tag + ta.value.slice(ta.selectionEnd ?? pos);
  ta.focus();
  ta.selectionStart = ta.selectionEnd = pos + tag.length;
  ta.dispatchEvent(new Event('input'));
});

/** Gönderim sonucunu kullanıcıya özetler. */
function reportSend(r) {
  if (r.dryRun) {
    toast(`Önizleme: ${r.recipients} alıcı, ${r.segments} SMS kredisi.`);
  } else if (r.sent) {
    toast(`${r.sent} SMS gönderildi (${r.segments} kredi).`, 'ok');
  }
  if (r.failed) toast(`${r.failed} gönderim başarısız.`, 'err');
  if (r.skipped?.length) {
    const reasons = {};
    for (const s of r.skipped) reasons[s.reason] = (reasons[s.reason] || 0) + 1;
    toast(
      'Atlanan: ' + Object.entries(reasons).map(([k, v]) => `${v} × ${k}`).join(', '),
      'err'
    );
  }
  for (const g of r.groups || []) if (g.status === 'failed') toast(g.error, 'err');
}

/* ================================ Durum ================================= */

const state = { user: null, route: 'panel', settings: {}, selectedCustomer: null };

const NAV = [
  { group: 'Klinik' },
  { id: 'panel', label: 'Panel' },
  { id: 'kabul', label: 'Hasta Kabul' },
  { id: 'hastalar', label: 'Hastalar' },
  { group: 'Takvim' },
  { id: 'randevular', label: 'Randevular' },
  { id: 'hatirlatma', label: 'Hatırlatma' },
  { id: 'dogumgunu', label: 'Doğum Günü' },
  { group: 'Mesaj' },
  { id: 'toplusms', label: 'Toplu SMS' },
  { id: 'gecmis', label: 'SMS Geçmişi' },
  { id: 'sablonlar', label: 'Şablonlar' },
  { id: 'karaliste', label: 'Kara Liste' },
  { group: 'Sistem' },
  { id: 'ayarlar', label: 'Ayarlar' },
];

function renderNav() {
  el('nav').innerHTML = NAV.map((n) =>
    n.group
      ? `<div class="group">${n.group}</div>`
      : `<a href="#${n.id}" class="${state.route === n.id ? 'active' : ''}">${n.label}</a>`
  ).join('');
}

/* =============================== Görünümler ============================== */

const views = {};

/* ------------------------------- Panel ---------------------------------- */
views.panel = async () => {
  const d = await api('/dashboard');
  const card = (n, l, cls = '') => `<div class="stat ${cls}"><div class="n">${n}</div><div class="l">${l}</div></div>`;
  el('view').innerHTML = `
    <div class="stats">
      ${card(d.customers, 'Müşteri')}
      ${card(d.patients, 'Hasta')}
      ${card(d.dueToday, 'Bugün aşı zamanı', 'warn')}
      ${card(d.dueSoon, 'Yaklaşan aşı', 'warn')}
      ${card(d.overdue, 'Gecikmiş aşı', 'bad')}
      ${card(d.appointmentsToday, 'Bugünkü randevu')}
      ${card(d.birthdaysToday, 'Bugün doğum günü')}
      ${card(d.smsToday, 'Bugün gönderilen SMS', 'ok')}
    </div>
    <div class="card"><div class="body">
      <p class="muted" style="margin:0 0 12px">Hızlı işlemler</p>
      <div class="row">
        <a class="btn primary" href="#hatirlatma">Aşı hatırlatmalarını gönder</a>
        <a class="btn" href="#kabul">Yeni müşteri / hasta</a>
        <a class="btn" href="#randevular">Randevu ekle</a>
        <a class="btn" href="#toplusms">Toplu SMS</a>
      </div>
    </div></div>`;
};

/* ---------------------------- Hasta Kabul ------------------------------- */

views.kabul = async () => {
  el('view').innerHTML = `
    <div class="split">
      <div>
        <div class="card">
          <header><h2>Arama</h2><button class="btn primary sm" id="newCustomer">Yeni Müşteri</button></header>
          <div class="body" style="padding-bottom:12px">
            <input id="custSearch" placeholder="Müşteri adı, GSM veya hasta adı">
          </div>
          <div class="tree" id="custList"></div>
          <div class="body" style="border-top:1px solid var(--line)">
            <span class="muted" id="custCount"></span>
          </div>
        </div>
      </div>
      <div id="custDetail"><div class="card"><div class="empty">Soldan bir müşteri seçin veya yeni müşteri ekleyin.</div></div></div>
    </div>`;

  let timer;
  el('custSearch').addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(loadCustomers, 250);
  });
  el('newCustomer').addEventListener('click', () => customerForm(null));
  await loadCustomers();
  if (state.selectedCustomer) showCustomer(state.selectedCustomer);
};

async function loadCustomers() {
  const q = el('custSearch')?.value || '';
  const { rows, count } = await api('/customers?q=' + encodeURIComponent(q));
  el('custCount').textContent = `${count} kayıt bulundu`;
  el('custList').innerHTML =
    rows.length === 0
      ? '<div class="empty">Kayıt yok</div>'
      : rows
          .map(
            (c) => `<div class="c ${state.selectedCustomer === c.id ? 'active' : ''}" data-id="${c.id}">
              <div>${esc(c.full_name)}</div>
              <div class="sub">${fmtGsm(c.gsm) || 'GSM yok'} · ${c.patient_count} hasta</div>
            </div>`
          )
          .join('');
  el('custList').querySelectorAll('.c').forEach((n) =>
    n.addEventListener('click', () => showCustomer(Number(n.dataset.id)))
  );
}

async function showCustomer(id) {
  state.selectedCustomer = id;
  el('custList')?.querySelectorAll('.c').forEach((n) =>
    n.classList.toggle('active', Number(n.dataset.id) === id)
  );
  const c = await api('/customers/' + id);
  el('custDetail').innerHTML = `
    <div class="card">
      <header>
        <div><h2 style="margin:0">${esc(c.full_name)}</h2>
          <span class="muted" style="font-size:12px">Protokol No: ${c.protocol_no ?? '-'}</span></div>
        <div class="row">
          <button class="btn sm" id="editCust">Düzenle</button>
          <button class="btn blue sm" id="smsCust" ${c.gsm ? '' : 'disabled'}>SMS</button>
          <button class="btn primary sm" id="addPatient">+ Hasta</button>
          <button class="btn danger sm" id="delCust">Sil</button>
        </div>
      </header>
      <div class="body">
        <div class="grid3">
          <div><div class="muted" style="font-size:12px">GSM</div><div>${fmtGsm(c.gsm) || '-'}</div></div>
          <div><div class="muted" style="font-size:12px">E-posta</div><div>${esc(c.email) || '-'}</div></div>
          <div><div class="muted" style="font-size:12px">Kimlik No</div><div>${esc(c.identity_no) || '-'}</div></div>
        </div>
        <div class="grid3" style="margin-top:12px">
          <div><div class="muted" style="font-size:12px">Adres</div><div>${esc([c.address, c.district, c.city].filter(Boolean).join(', ')) || '-'}</div></div>
          <div><div class="muted" style="font-size:12px">SMS izni</div>
            <div>${c.allow_sms ? '<span class="tag green">Açık</span>' : '<span class="tag red">Kapalı</span>'}</div></div>
          <div><div class="muted" style="font-size:12px">Bakiye</div><div>${Number(c.balance || 0).toFixed(2)} ₺</div></div>
        </div>
        ${c.description ? `<div style="margin-top:14px"><div class="muted" style="font-size:12px">Açıklama</div><div>${esc(c.description)}</div></div>` : ''}
      </div>
    </div>
    <div class="card">
      <header><h2>Hastalar (${c.patients.length})</h2></header>
      ${
        c.patients.length === 0
          ? '<div class="empty">Bu müşteriye bağlı hasta yok.</div>'
          : `<div class="table-wrap"><table>
              <thead><tr><th>Adı</th><th>Tür / Irk</th><th>Cinsiyet</th><th>Yaş</th><th></th></tr></thead>
              <tbody>${c.patients
                .map(
                  (p) => `<tr>
                    <td><b>${esc(p.name)}</b></td>
                    <td>${esc(p.species)}${p.breed ? ' / ' + esc(p.breed) : ''}</td>
                    <td>${esc(p.gender) || '-'}</td>
                    <td>${esc(p.age_text) || '-'}</td>
                    <td class="nowrap"><button class="btn sm" data-patient="${p.id}">Kart</button></td>
                  </tr>`
                )
                .join('')}</tbody></table></div>`
      }
    </div>`;

  el('editCust').addEventListener('click', () => customerForm(c));
  el('delCust').addEventListener('click', async () => {
    if (!confirm(`${c.full_name} ve bağlı hastaları silinecek. Emin misiniz?`)) return;
    await api('/customers/' + c.id, { method: 'DELETE' });
    toast('Müşteri silindi.', 'ok');
    state.selectedCustomer = null;
    views.kabul();
  });
  el('addPatient').addEventListener('click', () => patientForm(null, c.id));
  el('smsCust').addEventListener('click', () => singleSmsForm(c));
  el('custDetail').querySelectorAll('[data-patient]').forEach((b) =>
    b.addEventListener('click', () => showPatient(Number(b.dataset.patient)))
  );
}

function customerForm(c) {
  const v = (k) => esc(c?.[k] ?? '');
  openModal(c ? 'Müşteri Düzenle' : 'Yeni Müşteri', `
    <form id="custForm">
      <div class="grid2">
        <label class="f">Adı Soyadı *<input name="full_name" required value="${v('full_name')}"></label>
        <label class="f">GSM<input name="gsm" placeholder="0542 405 61 45" value="${fmtGsm(c?.gsm)}"></label>
        <label class="f">E-posta<input name="email" type="email" value="${v('email')}"></label>
        <label class="f">Kimlik No<input name="identity_no" value="${v('identity_no')}"></label>
        <label class="f">Kart No<input name="card_no" value="${v('card_no')}"></label>
        <label class="f">Doğum Tarihi<input name="birth_date" type="date" value="${v('birth_date')}"></label>
        <label class="f">İlçe<input name="district" value="${v('district')}"></label>
        <label class="f">İl<input name="city" value="${v('city')}"></label>
      </div>
      <label class="f">Adres<input name="address" value="${v('address')}"></label>
      <label class="f">Açıklama<textarea name="description" style="min-height:60px">${v('description')}</textarea></label>
      <label class="chk"><input type="checkbox" name="allow_sms" ${c == null || c.allow_sms ? 'checked' : ''}> SMS gönderilebilir (KVKK izni)</label>
      <label class="chk"><input type="checkbox" name="allow_email" ${c == null || c.allow_email ? 'checked' : ''}> E-posta gönderilebilir</label>
      <div class="row" style="justify-content:flex-end; margin-top:8px">
        <button type="button" class="btn" data-close>Vazgeç</button>
        <button class="btn primary">Kaydet</button>
      </div>
      <div class="error" id="custErr"></div>
    </form>`);

  el('custForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    body.allow_sms = fd.has('allow_sms');
    body.allow_email = fd.has('allow_email');
    try {
      if (c) {
        await api('/customers/' + c.id, { method: 'PUT', body });
        toast('Müşteri güncellendi.', 'ok');
        closeModal();
        showCustomer(c.id);
      } else {
        const r = await api('/customers', { method: 'POST', body });
        toast('Müşteri eklendi.', 'ok');
        closeModal();
        await loadCustomers();
        showCustomer(r.id);
      }
    } catch (err) {
      el('custErr').textContent = err.message;
    }
  });
}

/* ------------------------------ Hasta kartı ----------------------------- */

views.hastalar = async () => {
  el('view').innerHTML = `
    <div class="card">
      <header><h2>Hastalar</h2><input id="pq" placeholder="Hasta, sahip veya çip no" style="max-width:280px"></header>
      <div id="pList"></div>
    </div>`;
  const load = async () => {
    const { rows } = await api('/patients?q=' + encodeURIComponent(el('pq').value));
    el('pList').innerHTML = rows.length === 0 ? '<div class="empty">Kayıt yok</div>' : `
      <div class="table-wrap"><table>
        <thead><tr><th>Hasta</th><th>Tür / Irk</th><th>Sahibi</th><th>GSM</th><th>Yaş</th><th></th></tr></thead>
        <tbody>${rows.map((p) => `<tr>
          <td><b>${esc(p.name)}</b></td>
          <td>${esc(p.species)}${p.breed ? ' / ' + esc(p.breed) : ''}</td>
          <td>${esc(p.customer_name)}</td>
          <td class="nowrap">${fmtGsm(p.gsm)}</td>
          <td>${esc(p.age_text)}</td>
          <td><button class="btn sm" data-patient="${p.id}">Kart</button></td>
        </tr>`).join('')}</tbody></table></div>`;
    el('pList').querySelectorAll('[data-patient]').forEach((b) =>
      b.addEventListener('click', () => showPatient(Number(b.dataset.patient)))
    );
  };
  let t;
  el('pq').addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
  await load();
};

async function showPatient(id) {
  const p = await api('/patients/' + id);
  const types = await api('/vaccine-types');
  const tdy = today();

  const vaccRow = (v) => {
    const late = v.status === 'planned' && v.due_date < tdy;
    const cls = v.status === 'done' ? 'done' : late ? 'late' : 'due';
    const date = v.status === 'done' ? v.applied_date : v.due_date;
    return `<div class="vacc">
      <span class="d ${cls}">${trDate(date)}</span>
      <span class="n">${esc(v.vaccine_name)}</span>
      ${v.status === 'planned' ? `<button class="btn green sm" data-done="${v.id}">Yapıldı</button>` : ''}
      <button class="btn ghost sm" data-delv="${v.id}">Sil</button>
    </div>`;
  };

  openModal(`${p.name} — Hasta Kartı`, `
    <div class="grid2">
      <div>
        <div class="grid2">
          <div><div class="muted" style="font-size:12px">Tür</div><div>${esc(p.species)}</div></div>
          <div><div class="muted" style="font-size:12px">Irk</div><div>${esc(p.breed) || '-'}</div></div>
          <div><div class="muted" style="font-size:12px">Cinsiyet</div><div>${esc(p.gender) || '-'}</div></div>
          <div><div class="muted" style="font-size:12px">Renk</div><div>${esc(p.color) || '-'}</div></div>
          <div><div class="muted" style="font-size:12px">Doğum Tarihi</div><div>${trDate(p.birth_date) || '-'}</div></div>
          <div><div class="muted" style="font-size:12px">Yaş</div><div>${esc(p.age_text) || '-'}</div></div>
          <div><div class="muted" style="font-size:12px">Ağırlık</div><div>${p.weight ? p.weight + ' kg' : '-'}</div></div>
          <div><div class="muted" style="font-size:12px">Protokol</div><div>${p.protocol_no ?? '-'}</div></div>
        </div>
        <div style="margin-top:10px" class="muted">Sahibi: <b>${esc(p.customer_name)}</b> · ${fmtGsm(p.gsm)}</div>
        <div class="row" style="margin-top:14px">
          <button class="btn sm" id="editPat">Düzenle</button>
          <button class="btn sm" id="addVisit">Muayene Ekle</button>
        </div>
      </div>
      <div>
        <h4 style="margin:0 0 8px; font-size:13px">Aşı Kartı</h4>
        <div id="vaccList">${p.vaccinations.length ? p.vaccinations.map(vaccRow).join('') : '<div class="muted">Kayıt yok</div>'}</div>
        <form id="vaccForm" style="margin-top:14px">
          <label class="f">Aşı<select name="vaccine_name">${types.map((t) => `<option>${esc(t.name)}</option>`).join('')}</select></label>
          <div class="grid2">
            <label class="f">Yapıldığı tarih<input type="date" name="applied_date" value="${tdy}"></label>
            <label class="f">veya planlanan<input type="date" name="due_date"></label>
          </div>
          <button class="btn primary block sm">Aşı Kaydet</button>
          <div class="hint">Yapıldı olarak kaydedilirse bir sonraki doz otomatik planlanır.</div>
        </form>
      </div>
    </div>
    ${p.visits.length ? `<h4 style="margin:18px 0 6px; font-size:13px">Son Muayeneler</h4>
      <div class="table-wrap"><table><thead><tr><th>Tarih</th><th>Şikayet</th><th>Tanı</th><th>Ücret</th></tr></thead>
      <tbody>${p.visits.slice(0, 10).map((v) => `<tr><td class="nowrap">${trDate(v.visit_date)}</td>
        <td>${esc(v.complaint) || '-'}</td><td>${esc(v.diagnosis) || '-'}</td>
        <td>${Number(v.fee || 0).toFixed(2)} ₺</td></tr>`).join('')}</tbody></table></div>` : ''}
  `);

  el('vaccForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const b = Object.fromEntries(new FormData(e.target).entries());
    if (b.due_date) b.applied_date = '';
    try {
      await api(`/patients/${p.id}/vaccinations`, { method: 'POST', body: b });
      toast('Aşı kaydedildi.', 'ok');
      showPatient(p.id);
    } catch (err) { toast(err.message, 'err'); }
  });
  el('modalBody').querySelectorAll('[data-done]').forEach((b) =>
    b.addEventListener('click', async () => {
      await api(`/vaccinations/${b.dataset.done}/complete`, { method: 'POST', body: {} });
      toast('Aşı yapıldı olarak işaretlendi.', 'ok');
      showPatient(p.id);
    })
  );
  el('modalBody').querySelectorAll('[data-delv]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('Aşı kaydı silinsin mi?')) return;
      await api('/vaccinations/' + b.dataset.delv, { method: 'DELETE' });
      showPatient(p.id);
    })
  );
  el('editPat').addEventListener('click', () => patientForm(p, p.customer_id));
  el('addVisit').addEventListener('click', () => visitForm(p));
}

function patientForm(p, customerId) {
  const v = (k) => esc(p?.[k] ?? '');
  const species = ['Kedi', 'Köpek', 'Kuş', 'Kemirgen', 'Sürüngen', 'Diğer'];
  openModal(p ? 'Hasta Düzenle' : 'Yeni Hasta', `
    <form id="patForm">
      <div class="grid2">
        <label class="f">Adı *<input name="name" required value="${v('name')}"></label>
        <label class="f">Tür<select name="species">${species
          .map((s) => `<option ${p?.species === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
        <label class="f">Irk<input name="breed" value="${v('breed')}"></label>
        <label class="f">Cinsiyet<select name="gender">
          <option value="">Seçiniz</option>
          <option ${p?.gender === 'Erkek' ? 'selected' : ''}>Erkek</option>
          <option ${p?.gender === 'Dişi' ? 'selected' : ''}>Dişi</option></select></label>
        <label class="f">Renk<input name="color" value="${v('color')}"></label>
        <label class="f">Doğum Tarihi<input name="birth_date" type="date" value="${v('birth_date')}"></label>
        <label class="f">Ağırlık (kg)<input name="weight" type="number" step="0.01" value="${v('weight')}"></label>
        <label class="f">Çip / HBS No<input name="chip_no" value="${v('chip_no')}"></label>
      </div>
      <label class="chk"><input type="checkbox" name="neutered" ${p?.neutered ? 'checked' : ''}> Kısırlaştırılmış</label>
      <label class="chk"><input type="checkbox" name="deceased" ${p?.deceased ? 'checked' : ''}> Vefat etti (hatırlatma gönderilmez)</label>
      <label class="f">Notlar<textarea name="notes" style="min-height:60px">${v('notes')}</textarea></label>
      <div class="row" style="justify-content:flex-end">
        <button type="button" class="btn" data-close>Vazgeç</button>
        <button class="btn primary">Kaydet</button>
      </div>
      <div class="error" id="patErr"></div>
    </form>`);

  el('patForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    body.neutered = fd.has('neutered');
    body.deceased = fd.has('deceased');
    if (!body.weight) delete body.weight;
    try {
      if (p) {
        await api('/patients/' + p.id, { method: 'PUT', body });
        toast('Hasta güncellendi.', 'ok');
        closeModal();
        showPatient(p.id);
      } else {
        body.customer_id = customerId;
        await api('/patients', { method: 'POST', body });
        toast('Hasta eklendi.', 'ok');
        closeModal();
        showCustomer(customerId);
      }
    } catch (err) { el('patErr').textContent = err.message; }
  });
}

function visitForm(p) {
  openModal(`${p.name} — Muayene`, `
    <form id="visitForm">
      <div class="grid2">
        <label class="f">Tarih<input type="date" name="visit_date" value="${today()}"></label>
        <label class="f">Ücret (₺)<input type="number" step="0.01" name="fee" value="0"></label>
        <label class="f">Ağırlık (kg)<input type="number" step="0.01" name="weight"></label>
        <label class="f">Ateş (°C)<input type="number" step="0.1" name="temperature"></label>
      </div>
      <label class="f">Şikayet<textarea name="complaint" style="min-height:56px"></textarea></label>
      <label class="f">Tanı<textarea name="diagnosis" style="min-height:56px"></textarea></label>
      <label class="f">Tedavi<textarea name="treatment" style="min-height:56px"></textarea></label>
      <div class="row" style="justify-content:flex-end">
        <button type="button" class="btn" data-close>Vazgeç</button>
        <button class="btn primary">Kaydet</button>
      </div>
    </form>`);
  el('visitForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    await api(`/patients/${p.id}/visits`, { method: 'POST', body });
    toast('Muayene kaydedildi.', 'ok');
    closeModal();
    showPatient(p.id);
  });
}

function singleSmsForm(c) {
  openModal(`${c.full_name} — SMS Gönder`, `
    <form id="ssForm">
      <div class="muted" style="margin-bottom:10px">Alıcı: ${fmtGsm(c.gsm)}</div>
      <textarea id="ssBody" placeholder="Mesajınız..."></textarea>
      <div class="counter" id="ssCount"></div>
      ${placeholderBar('ssBody')}
      <div class="row" style="justify-content:flex-end; margin-top:12px">
        <button type="button" class="btn" data-close>Vazgeç</button>
        <button class="btn primary">Gönder</button>
      </div>
    </form>`);
  bindCounter(el('ssBody'), el('ssCount'));
  el('ssForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api('/sms/single', { method: 'POST', body: { customer_id: c.id, body: el('ssBody').value } });
      reportSend(r);
      closeModal();
      loadBalance();
    } catch (err) { toast(err.message, 'err'); }
  });
}

/* ----------------------------- Hatırlatma ------------------------------- */

views.hatirlatma = async () => {
  const templates = await api('/templates');
  const offset = Number(state.settings.reminder_offset_days || 3);
  el('view').innerHTML = `
    <div class="card">
      <header><h2>Hatırlatma Listesi</h2></header>
      <div class="body">
        <div class="row">
          <label class="f" style="margin:0">Başlangıç<input type="date" id="rFrom" value="${today()}"></label>
          <label class="f" style="margin:0">Bitiş<input type="date" id="rTo" value="${addDays(today(), offset)}"></label>
          <label class="f" style="margin:0; flex:1; min-width:180px">Ara<input id="rQ" placeholder="Müşteri / hasta"></label>
          <button class="btn primary" id="rSearch">Listele</button>
          <button class="btn" id="rLate">Gecikmişler</button>
        </div>
      </div>
      <div id="rList"></div>
      <div class="body" style="border-top:1px solid var(--line)">
        <div class="grid2">
          <div>
            <label class="f">Şablon<select id="rTpl">
              ${templates.filter((t) => t.kind === 'asi' || t.kind === 'genel')
                .map((t) => `<option value="${t.id}" data-body="${esc(t.body)}">${esc(t.name)}</option>`).join('')}
            </select></label>
          </div>
          <div>
            <label class="f">Mesaj<textarea id="rBody"></textarea></label>
            <div class="counter" id="rCount"></div>
            ${placeholderBar('rBody')}
          </div>
        </div>
        <div class="row" style="justify-content:flex-end; margin-top:10px">
          <span class="muted" id="rSel">0 seçili</span>
          <button class="btn" id="rDry">Önizle (kredi hesabı)</button>
          <button class="btn primary" id="rSend">Seçili Kişilere SMS Gönder</button>
        </div>
      </div>
    </div>`;

  const tplSel = el('rTpl');
  const applyTpl = () => { el('rBody').value = tplSel.selectedOptions[0]?.dataset.body || ''; el('rBody').dispatchEvent(new Event('input')); };
  tplSel.addEventListener('change', applyTpl);
  bindCounter(el('rBody'), el('rCount'));
  applyTpl();

  const load = async () => {
    const qs = new URLSearchParams({ from: el('rFrom').value, to: el('rTo').value, q: el('rQ').value });
    const { rows } = await api('/reminders/vaccines?' + qs);
    const tdy = today();
    el('rList').innerHTML = rows.length === 0 ? '<div class="empty">Bu aralıkta hatırlatma yok.</div>' : `
      <div class="table-wrap"><table>
        <thead><tr><th><input type="checkbox" id="rAll"></th><th>Durum</th><th>Tarih</th>
          <th>Müşteri</th><th>GSM</th><th>Hasta</th><th>Aşı</th></tr></thead>
        <tbody>${rows.map((r) => {
          const late = r.due_date < tdy;
          const blocked = !r.gsm || !r.allow_sms;
          return `<tr>
            <td><input type="checkbox" class="rc" value="${r.vaccination_id}" ${blocked ? 'disabled' : ''}></td>
            <td>${r.sent ? `<span class="tag green">Gönderildi</span>`
                 : late ? '<span class="tag red">Gecikmiş</span>' : '<span class="tag orange">Bekliyor</span>'}</td>
            <td class="nowrap">${trDate(r.due_date)}</td>
            <td>${esc(r.customer_name)}</td>
            <td class="nowrap">${r.gsm ? fmtGsm(r.gsm) : '<span class="tag grey">GSM yok</span>'}
                ${r.gsm && !r.allow_sms ? '<span class="tag red">izin yok</span>' : ''}</td>
            <td>${esc(r.patient_name)}</td>
            <td>${esc(r.vaccine_name)}</td></tr>`;
        }).join('')}</tbody></table></div>`;

    const boxes = () => [...document.querySelectorAll('.rc')];
    const upd = () => { el('rSel').textContent = `${boxes().filter((b) => b.checked).length} seçili`; };
    el('rAll')?.addEventListener('change', (e) => {
      boxes().forEach((b) => { if (!b.disabled) b.checked = e.target.checked; });
      upd();
    });
    boxes().forEach((b) => b.addEventListener('change', upd));
    upd();
  };

  el('rSearch').addEventListener('click', load);
  el('rLate').addEventListener('click', () => {
    el('rFrom').value = '2000-01-01';
    el('rTo').value = addDays(today(), -1);
    load();
  });

  const send = async (dry) => {
    const ids = [...document.querySelectorAll('.rc:checked')].map((b) => Number(b.value));
    if (ids.length === 0) return toast('Hiç kayıt seçilmedi.', 'err');
    if (!dry && !confirm(`${ids.length} kişiye SMS gönderilecek. Onaylıyor musunuz?`)) return;
    try {
      const r = await api('/reminders/send', {
        method: 'POST',
        body: { kind: 'vaccination', ids, body: el('rBody').value, dry_run: dry },
      });
      reportSend(r);
      if (!dry) { load(); loadBalance(); }
    } catch (err) { toast(err.message, 'err'); }
  };
  el('rSend').addEventListener('click', () => send(false));
  el('rDry').addEventListener('click', () => send(true));
  await load();
};

/* ----------------------------- Doğum günü ------------------------------- */

views.dogumgunu = async () => {
  const templates = await api('/templates');
  el('view').innerHTML = `
    <div class="card">
      <header><h2>Doğum Günü Hatırlatma</h2>
        <input type="date" id="bOn" value="${today()}" style="max-width:180px"></header>
      <div id="bList"></div>
      <div class="body" style="border-top:1px solid var(--line)">
        <label class="f">Şablon<select id="bTpl">${templates
          .map((t) => `<option value="${t.id}" data-body="${esc(t.body)}" ${t.kind === 'dogumgunu' ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
        <label class="f">Mesaj<textarea id="bBody"></textarea></label>
        <div class="counter" id="bCount"></div>
        ${placeholderBar('bBody')}
        <div class="row" style="justify-content:flex-end; margin-top:10px">
          <button class="btn primary" id="bSend">Seçililere Gönder</button>
        </div>
      </div>
    </div>`;

  const tpl = el('bTpl');
  const apply = () => { el('bBody').value = tpl.selectedOptions[0]?.dataset.body || ''; el('bBody').dispatchEvent(new Event('input')); };
  tpl.addEventListener('change', apply);
  bindCounter(el('bBody'), el('bCount'));
  apply();

  const load = async () => {
    const { rows } = await api('/reminders/birthdays?on=' + el('bOn').value);
    el('bList').innerHTML = rows.length === 0 ? '<div class="empty">Bu tarihte doğum günü yok.</div>' : `
      <div class="table-wrap"><table>
        <thead><tr><th><input type="checkbox" id="bAll"></th><th>Hasta</th><th>Müşteri</th><th>GSM</th><th>Doğum</th><th>Durum</th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td><input type="checkbox" class="bc" value="${r.patient_id}" ${r.gsm && r.allow_sms ? '' : 'disabled'}></td>
          <td><b>${esc(r.patient_name)}</b></td><td>${esc(r.customer_name)}</td>
          <td class="nowrap">${fmtGsm(r.gsm) || '-'}</td><td class="nowrap">${trDate(r.birth_date)}</td>
          <td>${r.sent ? '<span class="tag green">Gönderildi</span>' : '<span class="tag orange">Bekliyor</span>'}</td>
        </tr>`).join('')}</tbody></table></div>`;
    el('bAll')?.addEventListener('change', (e) =>
      document.querySelectorAll('.bc').forEach((b) => { if (!b.disabled) b.checked = e.target.checked; })
    );
  };
  el('bOn').addEventListener('change', load);
  el('bSend').addEventListener('click', async () => {
    const ids = [...document.querySelectorAll('.bc:checked')].map((b) => Number(b.value));
    if (!ids.length) return toast('Hiç kayıt seçilmedi.', 'err');
    try {
      const r = await api('/reminders/send', { method: 'POST', body: { kind: 'birthday', ids, body: el('bBody').value } });
      reportSend(r); load(); loadBalance();
    } catch (err) { toast(err.message, 'err'); }
  });
  await load();
};

/* ------------------------------ Randevular ------------------------------ */

views.randevular = async () => {
  el('view').innerHTML = `
    <div class="card">
      <header><h2>Randevular</h2>
        <div class="row">
          <input type="date" id="aFrom" value="${today()}">
          <input type="date" id="aTo" value="${addDays(today(), 7)}">
          <button class="btn primary sm" id="aNew">+ Randevu</button>
        </div></header>
      <div id="aList"></div>
    </div>`;
  const load = async () => {
    const { rows } = await api(`/appointments?from=${el('aFrom').value}&to=${el('aTo').value}`);
    el('aList').innerHTML = rows.length === 0 ? '<div class="empty">Randevu yok.</div>' : `
      <div class="table-wrap"><table>
        <thead><tr><th>Tarih / Saat</th><th>Müşteri</th><th>Hasta</th><th>Sebep</th><th>Durum</th><th></th></tr></thead>
        <tbody>${rows.map((a) => `<tr>
          <td class="nowrap">${trDateTime(a.starts_at)}</td>
          <td>${esc(a.customer_name) || '-'}</td><td>${esc(a.patient_name) || '-'}</td>
          <td>${esc(a.reason) || '-'}</td>
          <td><span class="tag ${a.status === 'done' ? 'green' : a.status === 'cancelled' ? 'grey' : 'orange'}">${
            { planned: 'Planlandı', done: 'Geldi', cancelled: 'İptal' }[a.status] || a.status}</span></td>
          <td class="nowrap">
            <button class="btn sm" data-ok="${a.id}">Geldi</button>
            <button class="btn ghost sm" data-del="${a.id}">Sil</button></td>
        </tr>`).join('')}</tbody></table></div>`;
    el('aList').querySelectorAll('[data-ok]').forEach((b) => b.addEventListener('click', async () => {
      await api('/appointments/' + b.dataset.ok, { method: 'PUT', body: { status: 'done' } }); load();
    }));
    el('aList').querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (confirm('Randevu silinsin mi?')) { await api('/appointments/' + b.dataset.del, { method: 'DELETE' }); load(); }
    }));
  };
  el('aFrom').addEventListener('change', load);
  el('aTo').addEventListener('change', load);
  el('aNew').addEventListener('click', async () => {
    const { rows } = await api('/customers?limit=500');
    openModal('Yeni Randevu', `
      <form id="apForm">
        <label class="f">Müşteri<select name="customer_id" id="apCust"><option value="">Seçiniz</option>
          ${rows.map((c) => `<option value="${c.id}">${esc(c.full_name)}</option>`).join('')}</select></label>
        <label class="f">Hasta<select name="patient_id" id="apPat"><option value="">Önce müşteri seçin</option></select></label>
        <div class="grid2">
          <label class="f">Tarih / Saat *<input type="datetime-local" name="starts_at" required></label>
          <label class="f">Süre (dk)<input type="number" name="duration_min" value="30"></label>
        </div>
        <label class="f">Sebep<input name="reason" placeholder="Aşı, kontrol, ameliyat..."></label>
        <div class="row" style="justify-content:flex-end">
          <button type="button" class="btn" data-close>Vazgeç</button><button class="btn primary">Kaydet</button>
        </div>
      </form>`);
    el('apCust').addEventListener('change', async (e) => {
      if (!e.target.value) return;
      const c = await api('/customers/' + e.target.value);
      el('apPat').innerHTML = '<option value="">Seçiniz</option>' +
        c.patients.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    });
    el('apForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      await api('/appointments', { method: 'POST', body: Object.fromEntries(new FormData(e.target).entries()) });
      toast('Randevu eklendi.', 'ok'); closeModal(); load();
    });
  });
  await load();
};

/* ------------------------------- Toplu SMS ------------------------------ */

views.toplusms = async () => {
  const templates = await api('/templates');
  el('view').innerHTML = `
    <div class="card">
      <header><h2>Toplu SMS</h2></header>
      <div class="tabs" id="audTabs">
        <button class="active" data-aud="all">Müşteri Listesi</button>
        <button data-aud="debtors">Bakiyesi Olanlar</button>
        <button data-aud="species">Türe Göre</button>
        <button data-aud="inactive">Uzun Süredir Gelmeyenler</button>
        <button data-aud="manual">Manuel Liste</button>
      </div>
      <div class="body">
        <div class="split">
          <div>
            <div id="audOpts"></div>
            <div class="muted" id="audCount">Yükleniyor...</div>
            <div class="tree" id="audList" style="max-height:330px; margin-top:8px"></div>
          </div>
          <div>
            <label class="f">Şablon<select id="tTpl"><option value="">— şablon seçin —</option>
              ${templates.map((t) => `<option value="${t.id}" data-body="${esc(t.body)}">${esc(t.name)}</option>`).join('')}
            </select></label>
            <label class="f">Mesaj<textarea id="tBody" style="min-height:130px"></textarea></label>
            <div class="counter" id="tCount"></div>
            ${placeholderBar('tBody')}
            <label class="chk" style="margin-top:12px"><input type="checkbox" id="tComm"> Ticari (pazarlama) gönderim</label>
            <div id="tCommOpts" class="hidden">
              <label class="f">Alıcı tipi<select id="tType">
                <option value="BIREYSEL">Bireysel</option><option value="TACIR">Tacir</option></select></label>
              <div class="hint">Ticari gönderimler İYS'ye tabidir. İzinsiz ticari SMS cezaya yol açar —
                hatırlatma / bilgilendirme mesajlarında bu kutuyu işaretlemeyin.</div>
            </div>
            <div class="row" style="justify-content:flex-end; margin-top:14px">
              <button class="btn" id="tDry">Önizle</button>
              <button class="btn primary" id="tSend">Gönder</button>
            </div>
          </div>
        </div>
      </div>
    </div>`;

  const tpl = el('tTpl');
  tpl.addEventListener('change', () => {
    el('tBody').value = tpl.selectedOptions[0]?.dataset.body || '';
    el('tBody').dispatchEvent(new Event('input'));
  });
  bindCounter(el('tBody'), el('tCount'));
  el('tComm').addEventListener('change', (e) => el('tCommOpts').classList.toggle('hidden', !e.target.checked));

  let aud = 'all';
  let rows = [];

  const loadAud = async () => {
    if (aud === 'manual') {
      el('audOpts').innerHTML = `<label class="f">Numaralar (her satıra bir tane)
        <textarea id="manualList" style="min-height:200px" placeholder="0542 405 61 45"></textarea></label>`;
      el('audCount').textContent = '';
      el('audList').innerHTML = '';
      return;
    }
    el('audOpts').innerHTML = aud === 'species'
      ? `<label class="f">Tür<select id="audSpecies">
          <option>Kedi</option><option>Köpek</option><option>Kuş</option><option>Diğer</option></select></label>`
      : aud === 'inactive'
      ? `<label class="f">Kaç gündür gelmeyenler<input type="number" id="audDays" value="365"></label>`
      : '';
    el('audSpecies')?.addEventListener('change', loadAud);
    el('audDays')?.addEventListener('change', loadAud);

    const qs = new URLSearchParams({ kind: aud });
    if (aud === 'species') qs.set('species', el('audSpecies')?.value || 'Kedi');
    if (aud === 'inactive') qs.set('days', el('audDays')?.value || '365');
    const data = await api('/bulk/audience?' + qs);
    rows = data.rows;
    el('audCount').textContent = `${data.count} alıcı`;
    el('audList').innerHTML = rows.map((r) =>
      `<div class="c"><label class="chk" style="margin:0">
        <input type="checkbox" class="ac" value="${r.customer_id}" checked>
        <span>${esc(r.name)} <span class="sub">${fmtGsm(r.gsm)}</span></span></label></div>`
    ).join('');
  };

  el('audTabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-aud]');
    if (!b) return;
    el('audTabs').querySelectorAll('button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    aud = b.dataset.aud;
    loadAud();
  });

  const send = async (dry) => {
    const body = {
      body: el('tBody').value,
      commercial: el('tComm').checked,
      recipient_type: el('tType')?.value || 'BIREYSEL',
      dry_run: dry,
    };
    if (aud === 'manual') {
      body.manual = el('manualList').value.split('\n').map((s) => s.trim()).filter(Boolean);
      if (!body.manual.length) return toast('Numara listesi boş.', 'err');
    } else {
      body.customer_ids = [...document.querySelectorAll('.ac:checked')].map((b) => Number(b.value));
      if (!body.customer_ids.length) return toast('Hiç alıcı seçilmedi.', 'err');
    }
    const n = body.manual?.length || body.customer_ids.length;
    if (!dry && !confirm(`${n} kişiye SMS gönderilecek. Onaylıyor musunuz?`)) return;
    try {
      reportSend(await api('/bulk/send', { method: 'POST', body }));
      if (!dry) loadBalance();
    } catch (err) { toast(err.message, 'err'); }
  };
  el('tSend').addEventListener('click', () => send(false));
  el('tDry').addEventListener('click', () => send(true));
  await loadAud();
};

/* ------------------------------ SMS Geçmişi ----------------------------- */

views.gecmis = async () => {
  el('view').innerHTML = `
    <div class="card">
      <header><h2>SMS Geçmişi</h2>
        <div class="row">
          <input type="date" id="hFrom" value="${addDays(today(), -30)}">
          <input type="date" id="hTo" value="${today()}">
          <input id="hQ" placeholder="Ara">
          <button class="btn primary sm" id="hGo">Listele</button>
        </div></header>
      <div id="hStats" class="body" style="border-bottom:1px solid var(--line)"></div>
      <div id="hList"></div>
    </div>`;
  const load = async () => {
    const qs = new URLSearchParams({ from: el('hFrom').value, to: el('hTo').value, q: el('hQ').value });
    const { rows, totals } = await api('/sms/history?' + qs);
    el('hStats').innerHTML = `<div class="row">
      <span>Toplam: <b>${totals.total || 0}</b></span>
      <span>Başarılı: <b style="color:var(--green)">${totals.sent || 0}</b></span>
      <span>Hatalı: <b style="color:var(--red)">${totals.failed || 0}</b></span>
      <span>Kredi: <b>${totals.segments || 0}</b></span></div>`;
    el('hList').innerHTML = rows.length === 0 ? '<div class="empty">Kayıt yok.</div>' : `
      <div class="table-wrap"><table>
        <thead><tr><th>Tarih</th><th>Müşteri</th><th>GSM</th><th>Tür</th><th>Mesaj</th><th>Durum</th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td class="nowrap">${trDateTime(r.sent_at)}</td>
          <td>${esc(r.customer_name) || '-'}</td>
          <td class="nowrap">${fmtGsm(r.gsm)}</td>
          <td><span class="tag blue">${esc(r.kind)}</span></td>
          <td style="max-width:360px">${esc(r.body)}</td>
          <td>${r.status === 'sent' ? '<span class="tag green">Gönderildi</span>'
               : `<span class="tag red" title="${esc(r.error)}">Hata</span>`}</td>
        </tr>`).join('')}</tbody></table></div>`;
  };
  el('hGo').addEventListener('click', load);
  await load();
};

/* ------------------------------- Şablonlar ------------------------------ */

views.sablonlar = async () => {
  const rows = await api('/templates');
  el('view').innerHTML = `
    <div class="card">
      <header><h2>SMS Şablonları</h2><button class="btn primary sm" id="tplNew">+ Şablon</button></header>
      <div class="table-wrap"><table>
        <thead><tr><th>Ad</th><th>Tür</th><th>İçerik</th><th>Kredi</th><th></th></tr></thead>
        <tbody>${rows.map((t) => {
          const i = smsInfo(t.body);
          return `<tr><td><b>${esc(t.name)}</b></td><td><span class="tag grey">${esc(t.kind)}</span></td>
            <td>${esc(t.body)}</td><td class="nowrap">${i.segments} SMS</td>
            <td class="nowrap"><button class="btn sm" data-edit="${t.id}">Düzenle</button>
              <button class="btn ghost sm" data-del="${t.id}">Sil</button></td></tr>`;
        }).join('')}</tbody></table></div>
    </div>`;

  const form = (t) => {
    openModal(t ? 'Şablon Düzenle' : 'Yeni Şablon', `
      <form id="tplForm">
        <label class="f">Ad *<input name="name" required value="${esc(t?.name ?? '')}"></label>
        <label class="f">Tür<select name="kind">
          ${['asi', 'randevu', 'dogumgunu', 'genel'].map((k) =>
            `<option ${t?.kind === k ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
        <label class="f">İçerik *<textarea name="body" id="tplBody" required>${esc(t?.body ?? '')}</textarea></label>
        <div class="counter" id="tplCount"></div>
        ${placeholderBar('tplBody')}
        <div class="row" style="justify-content:flex-end; margin-top:10px">
          <button type="button" class="btn" data-close>Vazgeç</button><button class="btn primary">Kaydet</button>
        </div>
        <div class="error" id="tplErr"></div>
      </form>`);
    bindCounter(el('tplBody'), el('tplCount'));
    el('tplForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target).entries());
      try {
        await api(t ? '/templates/' + t.id : '/templates', { method: t ? 'PUT' : 'POST', body });
        toast('Kaydedildi.', 'ok'); closeModal(); views.sablonlar();
      } catch (err) { el('tplErr').textContent = err.message; }
    });
  };

  el('tplNew').addEventListener('click', () => form(null));
  el('view').querySelectorAll('[data-edit]').forEach((b) =>
    b.addEventListener('click', () => form(rows.find((r) => r.id === Number(b.dataset.edit))))
  );
  el('view').querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('Şablon silinsin mi?')) return;
      await api('/templates/' + b.dataset.del, { method: 'DELETE' });
      views.sablonlar();
    })
  );
};

/* ------------------------------ Kara liste ------------------------------ */

views.karaliste = async () => {
  const rows = await api('/blacklist');
  el('view').innerHTML = `
    <div class="card">
      <header><h2>Kara Liste</h2></header>
      <div class="body">
        <form id="blForm" class="row">
          <input name="gsm" placeholder="0542 405 61 45" required style="max-width:220px">
          <input name="reason" placeholder="Gerekçe (opsiyonel)" style="flex:1">
          <button class="btn primary">Ekle</button>
        </form>
        <div class="hint">Buradaki numaralara hiçbir koşulda SMS gönderilmez.</div>
      </div>
      ${rows.length === 0 ? '<div class="empty">Kara liste boş.</div>' : `
        <div class="table-wrap"><table>
          <thead><tr><th>GSM</th><th>Gerekçe</th><th>Eklenme</th><th></th></tr></thead>
          <tbody>${rows.map((r) => `<tr><td>${fmtGsm(r.gsm)}</td><td>${esc(r.reason) || '-'}</td>
            <td class="nowrap">${trDateTime(r.created_at)}</td>
            <td><button class="btn ghost sm" data-del="${r.id}">Çıkar</button></td></tr>`).join('')}</tbody>
        </table></div>`}
    </div>`;
  el('blForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/blacklist', { method: 'POST', body: Object.fromEntries(new FormData(e.target).entries()) });
      toast('Eklendi.', 'ok'); views.karaliste();
    } catch (err) { toast(err.message, 'err'); }
  });
  el('view').querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      await api('/blacklist/' + b.dataset.del, { method: 'DELETE' });
      views.karaliste();
    })
  );
};

/* -------------------------------- Ayarlar ------------------------------- */

views.ayarlar = async () => {
  const s = await api('/settings');
  state.settings = s;
  el('view').innerHTML = `
    <div class="card">
      <header><h2>Klinik Bilgileri</h2></header>
      <div class="body"><form id="clinicForm">
        <div class="grid2">
          <label class="f">Klinik Adı<input name="clinic_name" value="${esc(s.clinic_name)}"></label>
          <label class="f">Telefon<input name="clinic_phone" value="${esc(s.clinic_phone)}"></label>
          <label class="f">Hatırlatma kaç gün önce<input type="number" name="reminder_offset_days" value="${esc(s.reminder_offset_days)}"></label>
        </div>
        <button class="btn primary">Kaydet</button>
      </form></div>
    </div>

    <div class="card">
      <header><h2>SMS Sağlayıcı</h2></header>
      <div class="body"><form id="smsForm">
        <label class="f">Sağlayıcı<select name="sms_provider">
          <option value="mock" ${s.sms_provider === 'mock' ? 'selected' : ''}>Test modu (gerçek SMS gitmez)</option>
          <option value="organik" ${s.sms_provider === 'organik' ? 'selected' : ''}>Organik Haberleşme</option>
        </select></label>
        <label class="f">API Anahtarı<input name="sms_api_key" value="${esc(s.sms_api_key)}"
          placeholder="Organik panelinden: Kullanıcı Paneli > API Kontrol"></label>
        <div class="row">
          <button type="button" class="btn" id="testSms">Bağlantıyı Test Et</button>
          <span id="testOut" class="muted"></span>
        </div>
        <label class="f" style="margin-top:14px">SMS Başlığı
          <select name="sms_header_id" id="hdrSel">
            <option value="${esc(s.sms_header_id)}">${esc(s.sms_header_title || s.sms_header_id || '— test sonrası seçilir —')}</option>
          </select></label>
        <button class="btn primary">Kaydet</button>
        <div class="hint">Test modunda gönderimler yalnızca kayda geçer, operatöre gitmez.
          Gerçek gönderime geçmeden önce mutlaka "Önizle" ile kredi hesabını kontrol edin.</div>
      </form></div>
    </div>

    <div class="card">
      <header><h2>Şifre Değiştir</h2></header>
      <div class="body"><form id="pwForm">
        <div class="grid2">
          <label class="f">Mevcut şifre<input type="password" name="current_password" required></label>
          <label class="f">Yeni şifre<input type="password" name="new_password" required minlength="6"></label>
        </div>
        <button class="btn primary">Değiştir</button>
        <div class="hint">Şifre değişince tüm oturumlar kapanır, yeniden giriş yapmanız gerekir.</div>
      </form></div>
    </div>`;

  const save = async (form) => {
    const body = Object.fromEntries(new FormData(form).entries());
    state.settings = await api('/settings', { method: 'PUT', body });
    toast('Ayarlar kaydedildi.', 'ok');
    loadBalance();
  };
  el('clinicForm').addEventListener('submit', (e) => { e.preventDefault(); save(e.target); });
  el('smsForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const sel = el('hdrSel').selectedOptions[0];
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    body.sms_header_title = sel?.dataset.title || sel?.textContent || '';
    api('/settings', { method: 'PUT', body }).then((r) => {
      state.settings = r; toast('Ayarlar kaydedildi.', 'ok'); loadBalance();
    }).catch((err) => toast(err.message, 'err'));
  });

  el('testSms').addEventListener('click', async () => {
    el('testOut').textContent = 'Test ediliyor...';
    try {
      const r = await api('/settings/test-sms', {
        method: 'POST',
        body: { api_key: $('[name=sms_api_key]', el('smsForm')).value },
      });
      el('testOut').innerHTML = `<span style="color:var(--green)">Bağlantı başarılı</span> · Bakiye: <b>${r.balance} ₺</b>`;
      if (r.headers?.length) {
        el('hdrSel').innerHTML = r.headers
          .map((h) => `<option value="${h.id}" data-title="${esc(h.title)}" ${String(h.id) === String(s.sms_header_id) ? 'selected' : ''}>${esc(h.title)}</option>`)
          .join('');
      } else {
        el('testOut').innerHTML += ' · <span style="color:var(--orange-dark)">Onaylı SMS başlığı yok</span>';
      }
    } catch (err) {
      el('testOut').innerHTML = `<span style="color:var(--red)">${esc(err.message)}</span>`;
    }
  });

  el('pwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/me/password', { method: 'POST', body: Object.fromEntries(new FormData(e.target).entries()) });
      toast('Şifre değiştirildi, yeniden giriş yapın.', 'ok');
      setTimeout(() => location.reload(), 1200);
    } catch (err) { toast(err.message, 'err'); }
  });
};

/* ============================== Yönlendirme ============================= */

async function loadBalance() {
  try {
    const b = await api('/sms/balance');
    el('balanceBox').innerHTML = b.provider === 'organik'
      ? `SMS bakiyesi<br><b>${b.balance} ₺</b>`
      : `<span class="tag orange">Test modu</span><br>Gerçek SMS gönderilmiyor`;
  } catch (err) {
    el('balanceBox').innerHTML = `<span class="tag red">SMS hatası</span><br>${esc(err.message)}`;
  }
}

async function route() {
  const id = (location.hash || '#panel').slice(1);
  state.route = views[id] ? id : 'panel';
  renderNav();
  el('crumb').textContent = NAV.find((n) => n.id === state.route)?.label || '';
  el('view').innerHTML = '<div class="card"><div class="empty">Yükleniyor...</div></div>';
  try {
    await views[state.route]();
  } catch (err) {
    el('view').innerHTML = `<div class="card"><div class="empty">${esc(err.message)}</div></div>`;
  }
}

window.addEventListener('hashchange', route);

function renderAuth() {
  const logged = !!state.user;
  el('login').classList.toggle('hidden', logged);
  el('app').classList.toggle('hidden', !logged);
  if (logged) {
    el('whoami').textContent = `${state.user.full_name} (${state.user.role})`;
    route();
    loadBalance();
  }
}

el('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  el('loginError').textContent = '';
  const body = Object.fromEntries(new FormData(e.target).entries());
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Giriş başarısız.');
    state.user = data;
    state.settings = await api('/settings');
    renderAuth();
  } catch (err) {
    el('loginError').textContent = err.message;
  }
});

el('logoutBtn').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' });
  state.user = null;
  renderAuth();
});

(async function boot() {
  try {
    state.user = await api('/me');
    state.settings = await api('/settings');
  } catch {
    state.user = null;
  }
  renderAuth();
})();
