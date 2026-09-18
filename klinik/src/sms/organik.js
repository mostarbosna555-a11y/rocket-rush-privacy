'use strict';

/**
 * Organik Haberlesme API istemcisi.
 * Sema: https://apidocs.organikhaberlesme.com/  (OpenAPI: /api.json)
 * Kimlik dogrulama: API anahtari `X-Organik-API` basligi ile gonderilir.
 */

const BASE_URL = process.env.ORGANIK_BASE_URL || 'https://api.organikhaberlesme.com';
const AUTH_HEADER = process.env.ORGANIK_AUTH_HEADER || 'X-Organik-API';

class OrganikError extends Error {
  constructor(message, code, payload) {
    super(message);
    this.name = 'OrganikError';
    this.code = code;
    this.payload = payload;
  }
}

class OrganikClient {
  constructor(apiKey, { baseUrl = BASE_URL, timeoutMs = 30000 } = {}) {
    if (!apiKey) throw new OrganikError('Organik Haberleşme API anahtarı tanımlı değil.', 'no_api_key');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
  }

  async request(method, path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers: {
          [AUTH_HEADER]: this.apiKey,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        throw new OrganikError('Organik Haberleşme API zaman aşımına uğradı.', 'timeout');
      }
      throw new OrganikError(`Organik Haberleşme API'ye ulaşılamadı: ${err.message}`, 'network');
    }
    clearTimeout(timer);

    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new OrganikError(
        `Organik Haberleşme beklenmeyen bir cevap döndü (HTTP ${res.status}).`,
        'bad_response',
        text.slice(0, 500)
      );
    }

    if (!res.ok || json?.result === false) {
      const err = json?.error || {};
      throw new OrganikError(
        err.message || `Organik Haberleşme hatası (HTTP ${res.status}).`,
        err.code || res.status,
        json
      );
    }
    return json?.data !== undefined ? json.data : json;
  }

  /** Hesap bilgileri — API anahtarini dogrulamak icin kullanilir. */
  me() {
    return this.request('GET', '/me');
  }

  /** Kalan bakiye (TL). */
  balance() {
    return this.request('GET', '/user/payment/balance');
  }

  /** Onayli SMS basliklari: [{ id, title, brand }] */
  headers() {
    return this.request('GET', '/sms/headers/get');
  }

  /**
   * SMS gonderir.
   * @param {object} opts
   * @param {string}   opts.message     Mesaj icerigi
   * @param {string[]} opts.recipients  90XXXXXXXXXX formatinda numaralar
   * @param {number}   opts.header      Onayli baslik ID'si
   * @param {boolean}  opts.commercial  Ticari gonderim mi (IYS)
   * @param {string}   opts.recipientType 'BIREYSEL' | 'TACIR' (ticari ise)
   * @param {string}   opts.type        'sms' | 'turkish' | 'unicode' | 'flash'
   * @param {string}   [opts.date]      'YYYY-MM-DD HH:mm:ss' — ileri tarihli gonderim
   * @param {number}   [opts.validity]  Zaman asimi (saat)
   */
  sendSms({ message, recipients, header, commercial = false, recipientType = 'BIREYSEL', type, date, validity }) {
    const body = {
      message,
      recipients,
      header: Number(header),
    };
    // API: ticari degilse commercial alanina false gonderilmeli.
    body.commercial = commercial ? recipientType : false;
    if (type) body.type = type;
    if (date) body.date = date;
    if (validity) body.validity = validity;
    return this.request('POST', '/sms/send', body);
  }

  /** Gonderim durumu: { id, delivered, waiting, failure, status } */
  reportDetail(transactionId) {
    return this.request('POST', '/sms/report/detail', { id: Number(transactionId) });
  }

  /** Planlanmis bir gonderimi iptal eder. */
  cancel(transactionId) {
    return this.request('POST', '/sms/send/cancel', { id: Number(transactionId) });
  }
}

module.exports = { OrganikClient, OrganikError, BASE_URL, AUTH_HEADER };
