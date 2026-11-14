'use strict';
// Glass Phone for iPhone (home-screen web app).
// The screens are the same as the desktop app's; this file stands in for the desktop
// "main process". It talks to Twilio straight from the phone (Twilio's API allows
// that), keeps settings on the phone, and keeps call recordings in the app's storage.
(function () {
  const VERSION = '1.4.0'; // filled in by scripts/build-web.js
  const LABEL = 'Glass Phone (iPhone)'; // name for what setup creates in Twilio
  const MAX_CLIP_BYTES = 20 * 1024 * 1024;
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
  const MEDIA_TTL = 60 * 60 * 1000;
  const IMAGE_EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif' };
  const REC_RATE = 24000;
  const STEMS = { me: 'Me', them: 'Them', both: 'Both' };

  // ---------- small helpers ----------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const timeout = (ms) => {
    if (AbortSignal.timeout) return AbortSignal.timeout(ms);
    const c = new AbortController();
    setTimeout(() => c.abort(), ms);
    return c.signal;
  };
  const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const utf8 = (s) => new TextEncoder().encode(s);

  const listeners = {};
  const emit = (ch, data) => (listeners[ch] || []).forEach((fn) => fn(data));
  const on = (ch) => (fn) => {
    (listeners[ch] = listeners[ch] || []).push(fn);
    return () => (listeners[ch] = listeners[ch].filter((f) => f !== fn));
  };

  // ---------- settings (kept on this phone) ----------

  const KEY = 'gp:config';
  let cache = null;
  function load() {
    if (cache) return cache;
    try {
      cache = JSON.parse(localStorage.getItem(KEY)) || {};
    } catch {
      cache = {};
    }
    cache.secrets = cache.secrets || {};
    cache.setup = cache.setup || {};
    cache.clips = cache.clips || [];
    cache.media = cache.media || [];
    cache.contacts = cache.contacts || {};
    cache.recording = { enabled: true, ...(cache.recording || {}) };
    cache.pendingDrops = cache.pendingDrops || [];
    return cache;
  }
  function save() {
    localStorage.setItem(KEY, JSON.stringify(cache));
  }
  function update(fn) {
    fn(load());
    save();
    return cache;
  }
  const getSecret = (k) => load().secrets[k] || null;
  const setSecret = (k, v) => update((c) => (v == null ? delete c.secrets[k] : (c.secrets[k] = v)));

  // ---------- recordings & clips storage (IndexedDB) ----------

  let dbp = null;
  function db() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open('glass-phone', 1);
        req.onupgradeneeded = () => {
          const d = req.result;
          d.createObjectStore('recs', { keyPath: 'id' });
          d.createObjectStore('parts', { keyPath: ['id', 'seq'] });
          d.createObjectStore('clips');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbp;
  }
  async function tx(store, mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      const s = t.objectStore(store);
      let out;
      const r = fn(s);
      if (r) r.onsuccess = () => (out = r.result);
      t.oncomplete = () => resolve(out);
      t.onerror = t.onabort = () => reject(t.error || new Error('Storage error'));
    });
  }
  const idb = {
    get: (store, key) => tx(store, 'readonly', (s) => s.get(key)),
    all: (store, range) => tx(store, 'readonly', (s) => s.getAll(range)),
    put: (store, val, key) => tx(store, 'readwrite', (s) => (key === undefined ? s.put(val) : s.put(val, key))),
    del: (store, key) => tx(store, 'readwrite', (s) => s.delete(key)),
  };

  // Ask iOS to keep our storage (it may otherwise clear it if the app goes unused for weeks).
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  // ---------- Twilio ----------

  class TwilioError extends Error {
    constructor(message, code, status) {
      super(message);
      this.code = code;
      this.status = status;
    }
  }

  function encode(params) {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) v.forEach((x) => usp.append(k, String(x)));
      else usp.append(k, String(v));
    }
    return usp;
  }

  function createClient(accountSid, authToken) {
    const auth = 'Basic ' + btoa(`${accountSid}:${authToken}`);
    async function request(method, url, params, form) {
      const headers = { Authorization: auth, Accept: 'application/json' };
      let body;
      if (form) body = form;
      else if (params && method === 'GET') url += (url.includes('?') ? '&' : '?') + encode(params).toString();
      else if (params) {
        body = encode(params);
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }
      let res;
      try {
        res = await fetch(url, { method, headers, body, signal: timeout(60000), cache: 'no-store' });
      } catch {
        throw new TwilioError("Couldn't reach Twilio. Check your internet connection.");
      }
      if (res.status === 204) return null;
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {}
      if (!res.ok) {
        let msg = (data && data.message) || `Twilio returned an error (HTTP ${res.status}).`;
        if (res.status === 401) msg = 'Twilio rejected your Account SID or Auth Token. Double-check them in Settings.';
        throw new TwilioError(msg, data && data.code, res.status);
      }
      return data;
    }
    // Downloads a file that needs your credentials (pictures, recordings).
    async function file(url, ms = 120000) {
      const res = await fetch(url, { headers: { Authorization: auth }, signal: timeout(ms) });
      if (!res.ok) throw new TwilioError(`Download failed (HTTP ${res.status}).`);
      return res.blob();
    }
    return {
      accountSid,
      request,
      file,
      API: `https://api.twilio.com/2010-04-01/Accounts/${accountSid}`,
      SL: 'https://serverless.twilio.com/v1',
      UP: 'https://serverless-upload.twilio.com/v1',
    };
  }

  const tw = {
    verifyAccount: (c) => c.request('GET', `${c.API}.json`),
    async listNumbers(c) {
      const r = await c.request('GET', `${c.API}/IncomingPhoneNumbers.json`, { PageSize: 100 });
      return (r.incoming_phone_numbers || []).map((n) => ({
        number: n.phone_number,
        name: n.friendly_name,
        sms: !!(n.capabilities && n.capabilities.sms),
        mms: !!(n.capabilities && n.capabilities.mms),
        voice: !!(n.capabilities && n.capabilities.voice),
      }));
    },
    async accountInfo(c) {
      const [acct, bal] = await Promise.all([c.request('GET', `${c.API}.json`), c.request('GET', `${c.API}/Balance.json`).catch(() => null)]);
      return { name: acct.friendly_name || '', type: acct.type || '', status: acct.status || '', balance: bal ? Number(bal.balance) : null, currency: bal ? bal.currency : null };
    },
    async findNumber(c, phoneNumber) {
      const r = await c.request('GET', `${c.API}/IncomingPhoneNumbers.json`, { PhoneNumber: phoneNumber });
      return (r.incoming_phone_numbers || [])[0] || null;
    },
    async sendSms(c, from, to, body, mediaUrl) {
      const params = { From: from, To: to };
      if (body) params.Body = body;
      if (mediaUrl) params.MediaUrl = mediaUrl;
      return slimMessage(await c.request('POST', `${c.API}/Messages.json`, params));
    },
    async getMessageMedia(c, messageSid) {
      const list = await c.request('GET', `${c.API}/Messages/${messageSid}/Media.json`);
      const out = [];
      for (const m of list.media_list || []) {
        if (!(m.content_type || '').startsWith('image/')) continue;
        const url = `https://api.twilio.com${m.uri.replace(/\.json$/, '')}`;
        try {
          const blob = await c.file(url, 60000);
          if (blob.size <= 6 * 1024 * 1024) out.push(URL.createObjectURL(blob));
        } catch {}
      }
      return out;
    },
    async listMessages(c, from) {
      const [inbound, outbound] = await Promise.all([
        c.request('GET', `${c.API}/Messages.json`, { To: from, PageSize: 200 }),
        c.request('GET', `${c.API}/Messages.json`, { From: from, PageSize: 200 }),
      ]);
      const all = [...(inbound.messages || []), ...(outbound.messages || [])].map(slimMessage);
      const seen = new Set();
      return all.filter((m) => (seen.has(m.sid) ? false : seen.add(m.sid)));
    },
    async callAndPlay(c, from, to, audioUrl, record) {
      const twiml = `<Response><Play>${xmlEscape(audioUrl)}</Play><Pause length="1"/><Hangup/></Response>`;
      const params = { From: from, To: to, Twiml: twiml };
      if (record) Object.assign(params, { Record: 'true', RecordingChannels: 'mono', RecordingTrack: 'inbound' });
      return slimCall(await c.request('POST', `${c.API}/Calls.json`, params));
    },
    async listCallRecordings(c, callSid) {
      const r = await c.request('GET', `${c.API}/Calls/${callSid}/Recordings.json`);
      return (r.recordings || []).map((x) => ({ sid: x.sid, status: x.status, duration: Number(x.duration || 0) }));
    },
    downloadRecording: async (c, sid) => (await c.file(`${c.API}/Recordings/${sid}.wav`)).arrayBuffer(),
    deleteRecording: (c, sid) => c.request('DELETE', `${c.API}/Recordings/${sid}.json`),
    getCall: async (c, sid) => slimCall(await c.request('GET', `${c.API}/Calls/${sid}.json`)),
    hangupCall: async (c, sid) => slimCall(await c.request('POST', `${c.API}/Calls/${sid}.json`, { Status: 'completed' })),
  };

  function xmlEscape(s) {
    return String(s).replace(/[<>&'"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[ch]));
  }

  function slimMessage(m) {
    return {
      sid: m.sid,
      from: m.from,
      to: m.to,
      body: m.body,
      status: m.status,
      direction: m.direction,
      date: m.date_sent || m.date_created,
      errorCode: m.error_code,
      errorMessage: m.error_message,
      numMedia: Number(m.num_media || 0),
    };
  }

  function slimCall(call) {
    return {
      sid: call.sid,
      status: call.status,
      to: call.to,
      duration: call.duration ? Number(call.duration) : null,
      startTime: call.start_time,
      endTime: call.end_time,
    };
  }

  async function voiceToken({ accountSid, apiKeySid, apiKeySecret, appSid, identity = 'glass-phone-iphone' }) {
    const now = Math.floor(Date.now() / 1000);
    const part = (o) => b64url(utf8(JSON.stringify(o)));
    const header = { typ: 'JWT', alg: 'HS256', cty: 'twilio-fpa;v=1' };
    const payload = {
      jti: `${apiKeySid}-${now}-${hex(6)}`,
      iss: apiKeySid,
      sub: accountSid,
      iat: now,
      exp: now + 3600,
      grants: { identity, voice: { incoming: { allow: false }, outgoing: { application_sid: appSid } } },
    };
    const unsigned = `${part(header)}.${part(payload)}`;
    const key = await crypto.subtle.importKey('raw', utf8(apiKeySecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8(unsigned)));
    return `${unsigned}.${b64url(sig)}`;
  }

  // ---------- cloud setup (Twilio Serverless), same as the desktop app ----------

  const VOICE_FUNCTION = `exports.handler = function (context, event, callback) {
  var to = String(event.To || '');
  var ok = /^\\+[1-9]\\d{6,14}$/.test(to);
  var xml = '<?xml version="1.0" encoding="UTF-8"?><Response>' +
    (ok ? '<Dial callerId="' + context.CALLER_ID + '" answerOnBridge="true"><Number>' + to + '</Number></Dial>'
        : '<Say>That number is not valid.</Say>') +
    '</Response>';
  if (typeof Twilio !== 'undefined' && Twilio.Response) {
    var r = new Twilio.Response();
    r.appendHeader('Content-Type', 'text/xml');
    r.setBody(xml);
    return callback(null, r);
  }
  return callback(null, xml);
};
`;

  async function uploadVersion(c, kind, serviceSid, resourceSid, { path, visibility, content, type, filename }) {
    const form = new FormData();
    form.append('Path', path);
    form.append('Visibility', visibility);
    form.append('Content', content instanceof Blob ? new Blob([content], { type }) : new Blob([content], { type }), filename);
    return c.request('POST', `${c.UP}/Services/${serviceSid}/${kind}/${resourceSid}/Versions`, null, form);
  }

  async function buildAndDeploy(c, setup, assetVersionSids, onStep = () => {}) {
    onStep('Building…');
    const params = { FunctionVersions: [setup.functionVersionSid], AssetVersions: assetVersionSids, Runtime: 'node22' };
    let build;
    try {
      build = await c.request('POST', `${c.SL}/Services/${setup.serviceSid}/Builds`, params);
    } catch (e) {
      if (e.status !== 400) throw e;
      delete params.Runtime;
      build = await c.request('POST', `${c.SL}/Services/${setup.serviceSid}/Builds`, params);
    }
    const started = Date.now();
    while (build.status === 'building') {
      if (Date.now() - started > 180000) throw new TwilioError('Twilio took too long to build. Try again in a minute.');
      await sleep(1500);
      build = await c.request('GET', `${c.SL}/Services/${setup.serviceSid}/Builds/${build.sid}`);
    }
    if (build.status !== 'completed') throw new TwilioError('Twilio could not build the cloud service (status: ' + build.status + ').');
    onStep('Publishing…');
    await c.request('POST', `${c.SL}/Services/${setup.serviceSid}/Environments/${setup.environmentSid}/Deployments`, { BuildSid: build.sid });
  }

  async function provision(c, { fromNumber, setup, clips, apiKeySecret }, persist, progress) {
    const step = async (id, label, fn) => {
      progress({ id, label, state: 'running' });
      try {
        await fn();
        progress({ id, label, state: 'done' });
      } catch (e) {
        progress({ id, label, state: 'error', message: e.message });
        throw e;
      }
    };
    await step('account', 'Check Twilio account', () => tw.verifyAccount(c));
    await step('number', 'Check your Twilio number', async () => {
      if (!(await tw.findNumber(c, fromNumber))) throw new TwilioError(`${fromNumber} isn't a number on this Twilio account. Buy one in the Twilio console, or fix the number in Settings.`);
    });
    await step('key', 'Create calling key', async () => {
      if (setup.apiKeySid && apiKeySecret) return;
      const key = await c.request('POST', `${c.API}/Keys.json`, { FriendlyName: LABEL });
      setup.apiKeySid = key.sid;
      persist(setup, key.secret);
    });
    await step('service', 'Create cloud service', async () => {
      if (!setup.serviceSid) {
        const svc = await c.request('POST', `${c.SL}/Services`, { UniqueName: 'glass-phone-ios-' + hex(3), FriendlyName: LABEL, IncludeCredentials: false });
        setup.serviceSid = svc.sid;
        persist(setup);
      }
      if (!setup.environmentSid) {
        const env = await c.request('POST', `${c.SL}/Services/${setup.serviceSid}/Environments`, { UniqueName: 'production', DomainSuffix: 'app' });
        setup.environmentSid = env.sid;
        setup.domain = env.domain_name;
        persist(setup);
      }
      const vars = `${c.SL}/Services/${setup.serviceSid}/Environments/${setup.environmentSid}/Variables`;
      if (setup.callerIdVariableSid) await c.request('POST', `${vars}/${setup.callerIdVariableSid}`, { Value: fromNumber });
      else setup.callerIdVariableSid = (await c.request('POST', vars, { Key: 'CALLER_ID', Value: fromNumber })).sid;
      setup.callerId = fromNumber;
      persist(setup);
    });
    await step('deploy', 'Deploy call handler', async () => {
      if (!setup.functionSid) {
        setup.functionSid = (await c.request('POST', `${c.SL}/Services/${setup.serviceSid}/Functions`, { FriendlyName: 'voice' })).sid;
        persist(setup);
      }
      if (!setup.functionVersionSid) {
        const ver = await uploadVersion(c, 'Functions', setup.serviceSid, setup.functionSid, {
          path: '/voice',
          visibility: 'protected',
          content: utf8(VOICE_FUNCTION),
          type: 'application/javascript',
          filename: 'voice.js',
        });
        setup.functionVersionSid = ver.sid;
        persist(setup);
      }
      await buildAndDeploy(c, setup, clips.map((x) => x.versionSid));
    });
    await step('app', 'Connect in-app calling', async () => {
      const voiceUrl = `https://${setup.domain}/voice`;
      if (setup.appSid) await c.request('POST', `${c.API}/Applications/${setup.appSid}.json`, { VoiceUrl: voiceUrl, VoiceMethod: 'POST' });
      else setup.appSid = (await c.request('POST', `${c.API}/Applications.json`, { FriendlyName: LABEL, VoiceUrl: voiceUrl, VoiceMethod: 'POST' })).sid;
      setup.complete = true;
      persist(setup);
    });
  }

  async function uploadAsset(c, setup, live, folder, { id, name, ext, content, type }, onStep) {
    onStep('Uploading…');
    const asset = await c.request('POST', `${c.SL}/Services/${setup.serviceSid}/Assets`, { FriendlyName: name.slice(0, 250) });
    const path = `/${folder}/${id}.${ext}`;
    const ver = await uploadVersion(c, 'Assets', setup.serviceSid, asset.sid, { path, visibility: 'public', content, type, filename: `${id}.${ext}` });
    await buildAndDeploy(c, setup, [...live.map((x) => x.versionSid), ver.sid], onStep);
    const size = content.size != null ? content.size : content.byteLength;
    return { id, name, assetSid: asset.sid, versionSid: ver.sid, url: `https://${setup.domain}${path}`, size, createdAt: new Date().toISOString() };
  }

  async function deleteAssets(c, setup, assets) {
    for (const a of assets) {
      try {
        await c.request('DELETE', `${c.SL}/Services/${setup.serviceSid}/Assets/${a.assetSid}`);
      } catch {}
    }
  }

  // ---------- app logic (mirrors the desktop main process) ----------

  function client() {
    const cfg = load();
    const token = getSecret('authToken');
    if (!cfg.accountSid || !token) throw new Error('Add your Twilio details in Settings first.');
    return createClient(cfg.accountSid, token);
  }

  function requireSetup() {
    const cfg = load();
    if (!cfg.setup.complete) throw new Error('Finish setup in Settings first (Save & set up).');
    return cfg;
  }

  function normalizeNumber(raw) {
    raw = String(raw || '').trim();
    const digits = raw.replace(/\D/g, '');
    if (raw.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? '+' + digits : null;
    if (digits.length === 10) return '+1' + digits;
    if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
    return null;
  }

  function mustNumber(raw) {
    const n = normalizeNumber(raw);
    if (!n) throw new Error(`"${raw}" doesn't look like a phone number.`);
    return n;
  }

  function liveAssets(cfg) {
    const now = Date.now();
    return [...cfg.clips, ...cfg.media.filter((m) => now - Date.parse(m.createdAt) < MEDIA_TTL)];
  }

  function publicState() {
    const cfg = load();
    return {
      accountSid: cfg.accountSid || '',
      fromNumber: cfg.fromNumber || '',
      hasToken: !!getSecret('authToken'),
      setupComplete: !!cfg.setup.complete,
      callingReady: !!(cfg.setup.complete && cfg.setup.appSid && getSecret('apiKeySecret')),
      version: VERSION,
      clips: cfg.clips.map(({ id, name, url, size, createdAt }) => ({ id, name, url, size, createdAt })),
      contacts: cfg.contacts,
      recording: { enabled: cfg.recording.enabled !== false, folder: 'On this iPhone' },
      platform: 'ios',
    };
  }

  // Twilio Serverless builds can't overlap, so uploads/deletes/setup run one at a time.
  let queue = Promise.resolve();
  function serial(fn) {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  }

  // Same reply shape as the desktop app: { ok, data } or { error }.
  const handle = (fn) => async (arg) => {
    try {
      return { ok: true, data: await fn(arg || {}) };
    } catch (e) {
      let message = e.message || String(e);
      if (e.code) message += ` (Twilio error ${e.code})`;
      return { error: message, code: e.code || null };
    }
  };

  // Images: turn HEIC (or anything the phone can show) into a JPEG.
  async function toJpeg(blob) {
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const scale = Math.min(1, 2048 / Math.max(img.naturalWidth, img.naturalHeight));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.naturalWidth * scale);
      cv.height = Math.round(img.naturalHeight * scale);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      return await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.85));
    } catch {
      throw new Error('Couldn’t read that photo. Try a JPG or PNG.');
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // ---------- WAV ----------

  function wavHeader(dataBytes, rate = REC_RATE) {
    const b = new DataView(new ArrayBuffer(44));
    const str = (o, s) => [...s].forEach((ch, i) => b.setUint8(o + i, ch.charCodeAt(0)));
    str(0, 'RIFF');
    b.setUint32(4, 36 + dataBytes, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    b.setUint32(16, 16, true);
    b.setUint16(20, 1, true);
    b.setUint16(22, 1, true);
    b.setUint32(24, rate, true);
    b.setUint32(28, rate * 2, true);
    b.setUint16(32, 2, true);
    b.setUint16(34, 16, true);
    str(36, 'data');
    b.setUint32(40, dataBytes, true);
    return b.buffer;
  }

  function parseWav(ab) {
    const v = new DataView(ab);
    const tag = (o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
    if (ab.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file');
    let fmt = null;
    let data = null;
    for (let o = 12; o + 8 <= ab.byteLength; ) {
      const id = tag(o);
      const size = v.getUint32(o + 4, true);
      if (id === 'fmt ') fmt = { format: v.getUint16(o + 8, true), channels: v.getUint16(o + 10, true), rate: v.getUint32(o + 12, true), bits: v.getUint16(o + 22, true) };
      else if (id === 'data') data = { off: o + 8, len: Math.min(size, ab.byteLength - o - 8) };
      o += 8 + size + (size & 1);
    }
    if (!fmt || !data) throw new Error('Damaged WAV file');
    let format = fmt.format === 0xfffe ? 1 : fmt.format;
    const bytesPer = format === 1 ? fmt.bits / 8 : 1;
    if (!(format === 1 && (fmt.bits === 16 || fmt.bits === 8)) && format !== 6 && format !== 7) throw new Error('Unsupported WAV format');
    const frames = Math.floor(data.len / (bytesPer * fmt.channels));
    const out = new Int16Array(frames);
    const sample = (i) => {
      const p = data.off + i;
      if (format === 7) return ulaw(v.getUint8(p));
      if (format === 6) return alaw(v.getUint8(p));
      return fmt.bits === 16 ? v.getInt16(p, true) : (v.getUint8(p) - 128) << 8;
    };
    for (let f = 0; f < frames; f++) {
      let sum = 0;
      for (let ch = 0; ch < fmt.channels; ch++) sum += sample((f * fmt.channels + ch) * bytesPer);
      out[f] = Math.round(sum / fmt.channels);
    }
    return { rate: fmt.rate, samples: out };
  }

  function ulaw(u) {
    u = ~u & 0xff;
    const t = (((u & 0x0f) << 3) + 0x84) << ((u & 0x70) >> 4);
    return u & 0x80 ? 0x84 - t : t - 0x84;
  }

  function alaw(a) {
    a ^= 0x55;
    let t = (a & 0x0f) << 4;
    const seg = (a & 0x70) >> 4;
    if (seg === 0) t += 8;
    else if (seg === 1) t += 0x108;
    else t = (t + 0x108) << (seg - 1);
    return a & 0x80 ? t : -t;
  }

  const wav = (parts, bytes, rate) => new Blob([wavHeader(bytes, rate), ...parts], { type: 'audio/wav' });

  function mix(me, them) {
    const a = new Int16Array(me.buffer, me.byteOffset, me.byteLength >> 1);
    const b = new Int16Array(them.buffer, them.byteOffset, them.byteLength >> 1);
    const n = Math.min(a.length, b.length);
    const out = new Int16Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.max(-32768, Math.min(32767, a[i] + b[i]));
    return out;
  }

  // ---------- recordings ----------

  const recs = new Map(); // id -> stored recording { id, kind, clip, number, startedAt, duration, rate, files: { me, them, both } }
  const recUrls = new Map(); // id -> { both, me, them } object URLs
  let recsLoaded = null;

  function recordingView(r) {
    if (!recUrls.has(r.id)) recUrls.set(r.id, { both: URL.createObjectURL(r.files.both), me: URL.createObjectURL(r.files.me), them: URL.createObjectURL(r.files.them) });
    return { id: r.id, kind: r.kind || 'live', clip: r.clip || null, number: r.number, startedAt: r.startedAt, duration: r.duration, folder: '', urls: recUrls.get(r.id) };
  }

  async function loadRecs() {
    if (!recsLoaded) {
      recsLoaded = idb.all('recs').then((list) => {
        for (const r of list) recs.set(r.id, r);
      });
    }
    await recsLoaded;
    return [...recs.values()].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  }

  async function storeRec(r) {
    await idb.put('recs', r);
    recs.set(r.id, r);
    return recordingView(r);
  }

  // Live calls: half-second chunks arrive while you talk. They're batched into
  // IndexedDB every few seconds so a long call doesn't have to sit in memory.
  const live = new Map();

  function recStart({ number }) {
    const n = mustNumber(number);
    const id = hex(8);
    live.set(id, { id, number: n, startedAt: new Date().toISOString(), frames: 0, seq: 0, buf: { me: [], them: [], both: [] }, bytes: 0, chain: Promise.resolve() });
    return id;
  }

  function flush(s) {
    if (!s.bytes) return s.chain;
    const part = { id: s.id, seq: s.seq++, me: new Blob(s.buf.me), them: new Blob(s.buf.them), both: new Blob(s.buf.both) };
    s.buf = { me: [], them: [], both: [] };
    s.bytes = 0;
    s.chain = s.chain.then(() => idb.put('parts', part)).catch(() => {});
    return s.chain;
  }

  function recChunk({ id, me, them }) {
    const s = live.get(String(id));
    if (!s) return false;
    const len = Math.min(me.byteLength, them.byteLength) & ~1;
    if (!len) return true;
    me = me.slice(0, len);
    them = them.slice(0, len);
    s.buf.me.push(me);
    s.buf.them.push(them);
    s.buf.both.push(mix(me, them));
    s.frames += len / 2;
    s.bytes += len;
    if (s.bytes >= REC_RATE * 2 * 5) flush(s); // every ~5 seconds
    return true;
  }

  async function recStop({ id }) {
    const s = live.get(String(id));
    if (!s) return null;
    live.delete(s.id);
    await flush(s);
    const range = IDBKeyRange.bound([s.id, 0], [s.id, Infinity]);
    const parts = await idb.all('parts', range);
    await tx('parts', 'readwrite', (st) => st.delete(range));
    if (s.frames < REC_RATE / 2) return null;
    parts.sort((a, b) => a.seq - b.seq);
    const bytes = s.frames * 2;
    const files = {};
    for (const k of Object.keys(STEMS)) files[k] = wav(parts.map((p) => p[k]), bytes, REC_RATE);
    return storeRec({ id: s.id, kind: 'live', number: s.number, startedAt: s.startedAt, duration: s.frames / REC_RATE, rate: REC_RATE, files });
  }

  // Leftover pieces from a call that never finished (the app was closed mid-call).
  async function cleanParts() {
    try {
      const parts = await idb.all('parts');
      for (const id of new Set(parts.map((p) => p.id))) if (!live.has(id)) await tx('parts', 'readwrite', (st) => st.delete(IDBKeyRange.bound([id, 0], [id, Infinity])));
    } catch {}
  }
  setTimeout(cleanParts, 4000);

  function fileName(r, stem) {
    const d = new Date(r.startedAt);
    const p = (n) => String(n).padStart(2, '0');
    const who = (load().contacts[r.number] || r.number).replace(/[\\/:*?"<>|]/g, '').trim();
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())} ${who} - ${STEMS[stem]}.wav`;
  }

  // "Share" a recording: the iPhone share sheet (Save to Files, AirDrop, …).
  // Must start right away, inside the tap, or iOS refuses.
  function shareRecording({ id }) {
    const r = recs.get(String(id));
    if (!r) throw new Error('That recording is gone.');
    const files = Object.keys(STEMS).map((k) => new File([r.files[k]], fileName(r, k), { type: 'audio/wav' }));
    if (navigator.canShare && navigator.canShare({ files })) {
      return navigator.share({ files, title: 'Call recording' }).catch((e) => {
        if (e && e.name !== 'AbortError') throw new Error('Couldn’t open the share sheet: ' + e.message);
      });
    }
    for (const f of files) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(f);
      a.download = f.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    }
  }

  async function deleteRecording({ id }) {
    await idb.del('recs', String(id));
    recs.delete(String(id));
    const u = recUrls.get(String(id));
    if (u) Object.values(u).forEach((x) => URL.revokeObjectURL(x));
    recUrls.delete(String(id));
  }

  // Call & play: Twilio records their side; the window adds your clip as the "Me" track.
  const dropTracks = new Map();
  function dropPending(callSid) {
    update((c) => (c.pendingDrops = c.pendingDrops.filter((p) => p.callSid !== callSid)));
  }

  async function dropFetch({ callSid }) {
    callSid = String(callSid);
    const pending = load().pendingDrops.find((p) => p.callSid === callSid);
    if (!pending) return null;
    const c = client();
    const call = await tw.getCall(c, callSid);
    if (['queued', 'initiated', 'ringing', 'in-progress'].includes(call.status)) return { wait: true };
    let rec = null;
    for (let i = 0; i < 40; i++) {
      const list = await tw.listCallRecordings(c, callSid);
      rec = list.find((r) => r.status === 'completed');
      if (rec || (!list.length && i >= 5)) break;
      await sleep(3000);
    }
    if (!rec) {
      dropPending(callSid);
      return null;
    }
    const { rate, samples } = parseWav(await tw.downloadRecording(c, rec.sid));
    const token = hex(8);
    dropTracks.set(token, { pending, recordingSid: rec.sid, rate, them: samples });
    let clipBytes = null;
    try {
      const saved = await idb.get('clips', pending.clipId); // clips added on this phone are kept here
      if (saved) clipBytes = new Uint8Array(await saved.arrayBuffer());
      else {
        const res = await fetch(pending.clipUrl, { signal: timeout(60000) });
        if (res.ok) clipBytes = new Uint8Array(await res.arrayBuffer());
      }
    } catch {}
    return { token, rate, frames: samples.length, clipBytes };
  }

  async function dropSave({ token, me }) {
    const t = dropTracks.get(String(token));
    if (!t) throw new Error('That recording expired. It will be fetched again next time you open the app.');
    dropTracks.delete(String(token));
    const frames = t.them.length;
    const mine = new Int16Array(frames);
    if (me && me.byteLength) mine.set(new Int16Array(me.buffer.slice(me.byteOffset, me.byteOffset + (me.byteLength & ~1))).subarray(0, frames));
    const both = mix(new Uint8Array(mine.buffer), new Uint8Array(t.them.buffer, t.them.byteOffset, t.them.byteLength));
    const p = t.pending;
    const files = { me: wav([mine], frames * 2, t.rate), them: wav([t.them], frames * 2, t.rate), both: wav([both], frames * 2, t.rate) };
    const view = await storeRec({ id: hex(8), kind: 'clip', clip: p.clipName, number: p.number, startedAt: p.createdAt, duration: frames / t.rate, rate: t.rate, files });
    dropPending(p.callSid);
    tw.deleteRecording(client(), t.recordingSid).catch(() => {}); // saved on the phone now
    return view;
  }

  // ---------- clips ----------

  const picked = new Map(); // "n/name.mp3" -> File (the desktop app uses file paths here)
  let pickN = 0;
  function remember(file) {
    const key = `${++pickN}/${file.name || 'clip.mp3'}`;
    picked.set(key, file);
    return key;
  }

  function pickClips() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept = '.mp3,.wav,audio/mpeg,audio/mp3,audio/wav,audio/x-wav';
      input.addEventListener('change', () => resolve([...input.files].map(remember)));
      input.addEventListener('cancel', () => resolve([]));
      input.click();
    });
  }

  // ---------- updates (the service worker keeps a copy of the app on the phone) ----------

  const up = { current: VERSION, enabled: 'serviceWorker' in navigator, status: 'idle', available: null, progress: 0, error: null };
  let reg = null;
  const setUp = (patch) => {
    Object.assign(up, patch);
    emit('update:state', { ...up });
  };

  async function latestVersion() {
    const res = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error(`Couldn’t check for updates (HTTP ${res.status}).`);
    return res.json();
  }

  function newer(a, b) {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
    return false;
  }

  function waitForWorker() {
    return new Promise((resolve) => {
      if (reg.waiting) return resolve();
      const track = (w) => w && w.addEventListener('statechange', () => w.state === 'installed' && resolve());
      track(reg.installing);
      reg.addEventListener('updatefound', () => track(reg.installing));
    });
  }

  async function checkUpdate({ manual } = {}) {
    if (!up.enabled || !reg) {
      if (manual) throw new Error('Updates aren’t available here. Open Glass Phone from your Home Screen.');
      return { ...up };
    }
    if (['checking', 'downloading', 'ready'].includes(up.status)) return { ...up };
    up.lastCheck = Date.now();
    setUp({ status: 'checking', error: null });
    try {
      const feed = await latestVersion();
      if (!newer(feed.version, VERSION)) {
        setUp({ status: 'up-to-date', available: null });
        return { ...up };
      }
      setUp({ status: 'downloading', available: { version: String(feed.version), notes: String(feed.notes || ''), page: '' }, progress: 0.3 });
      const ready = waitForWorker();
      await reg.update();
      await Promise.race([ready, sleep(60000).then(() => Promise.reject(new Error('The update took too long to download. It will be tried again later.')))]);
      setUp({ status: 'ready', progress: 1 });
    } catch (e) {
      setUp({ status: 'error', error: e.message || String(e) });
      if (manual) throw e;
    }
    return { ...up };
  }

  function installUpdate() {
    if (up.status !== 'ready' || !reg || !reg.waiting) throw new Error('No update is ready yet.');
    navigator.serviceWorker.addEventListener('controllerchange', () => location.reload());
    reg.waiting.postMessage('skipWaiting');
  }

  if (up.enabled && location.protocol !== 'file:') {
    navigator.serviceWorker
      .register('sw.js')
      .then((r) => {
        reg = r;
        if (r.waiting && navigator.serviceWorker.controller) setUp({ status: 'ready', available: { version: 'new', notes: '', page: '' } });
        setTimeout(() => checkUpdate().catch(() => {}), 6000);
        setInterval(() => checkUpdate().catch(() => {}), 30 * 60e3);
        document.addEventListener('visibilitychange', () => !document.hidden && Date.now() - (up.lastCheck || 0) > 10 * 60e3 && checkUpdate().catch(() => {}));
      })
      .catch(() => setUp({ enabled: false }));
  } else {
    up.enabled = false;
  }

  // The calling library is big, so it loads the first time you make a call.
  let sdk = null;
  function loadVoiceSdk() {
    if (window.Twilio && window.Twilio.Device) return Promise.resolve();
    if (!sdk) {
      sdk = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'twilio.min.js';
        s.onload = resolve;
        s.onerror = () => {
          sdk = null;
          reject(new Error('Couldn’t load calling. Check your internet connection.'));
        };
        document.head.append(s);
      });
    }
    return sdk;
  }

  // ---------- the API the screens use ----------

  const mediaCache = new Map();

  window.api = {
    getState: handle(() => publicState()),
    saveSettings: handle(async ({ accountSid, authToken, fromNumber }) => {
      accountSid = String(accountSid || '').trim();
      authToken = String(authToken || '').trim();
      if (!/^AC[0-9a-fA-F]{32}$/.test(accountSid)) throw new Error('The Account SID should start with "AC" followed by 32 letters and numbers.');
      const token = authToken || getSecret('authToken');
      if (!token) throw new Error('Paste your Auth Token.');
      const from = mustNumber(fromNumber);
      await tw.verifyAccount(createClient(accountSid, token));
      const cfg = load();
      if (cfg.accountSid && cfg.accountSid !== accountSid) {
        cfg.setup = {};
        cfg.clips = [];
        cfg.media = [];
        setSecret('apiKeySecret', null);
      }
      update((c) => {
        c.accountSid = accountSid;
        c.fromNumber = from;
        if (c.setup.callerId && c.setup.callerId !== from) c.setup.complete = false;
      });
      if (authToken) setSecret('authToken', authToken);
      return publicState();
    }),
    runSetup: handle(() =>
      serial(async () => {
        const cfg = load();
        const setup = { ...cfg.setup };
        await provision(
          client(),
          { fromNumber: cfg.fromNumber, setup, clips: liveAssets(cfg), apiKeySecret: getSecret('apiKeySecret') },
          (s, secret) => {
            if (secret) setSecret('apiKeySecret', secret);
            update((x) => (x.setup = { ...s }));
          },
          (p) => emit('setup:progress', p)
        );
        return publicState();
      })
    ),
    resetSetup: handle(() => {
      update((c) => {
        c.setup = {};
        c.clips = [];
        c.media = [];
      });
      setSecret('apiKeySecret', null);
      return publicState();
    }),
    onSetupProgress: on('setup:progress'),

    sendSms: handle(async ({ to, body }) => {
      const cfg = load();
      body = String(body || '').trim();
      if (!body) throw new Error('Type a message first.');
      if (!cfg.fromNumber) throw new Error('Add your Twilio number in Settings first.');
      return tw.sendSms(client(), cfg.fromNumber, mustNumber(to), body);
    }),
    sendMms: handle(({ to, body, image }) =>
      serial(async () => {
        const cfg = requireSetup();
        const number = mustNumber(to);
        body = String(body || '').trim();
        if (!image || !image.bytes) throw new Error('No picture attached.');
        let blob = new Blob([image.bytes]);
        const name = String(image.name || 'picture');
        let type = String(image.type || '').toLowerCase();
        if (!type || type === 'application/octet-stream') {
          const ext = (name.split('.').pop() || '').toLowerCase();
          type = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', heic: 'image/heic', heif: 'image/heif' }[ext] || type;
        }
        if (!IMAGE_EXT[type] || blob.size > MAX_IMAGE_BYTES) {
          if (type === 'image/gif') throw new Error('That GIF is over 5 MB, the limit for picture messages.');
          blob = await toJpeg(new Blob([image.bytes], { type }));
          type = 'image/jpeg';
        }
        if (blob.size > MAX_IMAGE_BYTES) throw new Error('That picture is over 5 MB, the limit for picture messages.');
        const progress = (label) => emit('mms:progress', { label });
        const now = Date.now();
        const expired = cfg.media.filter((m) => now - Date.parse(m.createdAt) >= MEDIA_TTL);
        const c = client();
        const asset = await uploadAsset(c, cfg.setup, liveAssets(cfg), 'img', { id: hex(10), name: 'picture', ext: IMAGE_EXT[type], content: blob, type }, (label) =>
          progress(label === 'Uploading…' ? 'Uploading picture…' : 'Preparing picture…')
        );
        update((x) => {
          x.media = x.media.filter((m) => !expired.some((e) => e.id === m.id));
          x.media.push(asset);
        });
        deleteAssets(c, cfg.setup, expired).catch(() => {});
        progress('Sending…');
        return tw.sendSms(c, cfg.fromNumber, number, body, asset.url);
      })
    ),
    onMmsProgress: on('mms:progress'),
    getMedia: handle(async ({ sid }) => {
      sid = String(sid || '');
      if (!/^MM[0-9a-f]{32}$/i.test(sid)) return [];
      if (mediaCache.has(sid)) return mediaCache.get(sid);
      const urls = await tw.getMessageMedia(client(), sid);
      mediaCache.set(sid, urls);
      return urls;
    }),
    listMessages: handle(() => {
      const cfg = load();
      if (!cfg.fromNumber || !cfg.accountSid) return [];
      return tw.listMessages(client(), cfg.fromNumber);
    }),
    setContact: handle(({ number, name }) => {
      const n = mustNumber(number);
      update((c) => {
        name = String(name || '').trim().slice(0, 60);
        if (name) c.contacts[n] = name;
        else delete c.contacts[n];
      });
      return publicState();
    }),

    voiceToken: handle(() => {
      const cfg = requireSetup();
      const secret = getSecret('apiKeySecret');
      if (!secret || !cfg.setup.appSid) throw new Error('In-app calling isn’t set up yet. Run setup in Settings.');
      return voiceToken({ accountSid: cfg.accountSid, apiKeySid: cfg.setup.apiKeySid, apiKeySecret: secret, appSid: cfg.setup.appSid });
    }),
    loadVoiceSdk,
    checkNumber: handle(({ to }) => mustNumber(to)),
    requestMic: handle(async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        s.getTracks().forEach((t) => t.stop());
        return true;
      } catch {
        return false;
      }
    }),
    openMicSettings: handle(() => {}),

    pickClips: handle(pickClips),
    uploadClip: handle(({ filePath }) =>
      serial(async () => {
        const cfg = requireSetup();
        const file = picked.get(filePath);
        if (!file) throw new Error('That file is no longer available. Choose it again.');
        const ext = (file.name.split('.').pop() || '').toLowerCase();
        if (!['mp3', 'wav'].includes(ext)) throw new Error('Only MP3 and WAV files can be played on calls.');
        if (file.size > MAX_CLIP_BYTES) throw new Error('That file is over 20 MB. Try a shorter clip or an MP3.');
        const clip = await uploadAsset(
          client(),
          cfg.setup,
          liveAssets(cfg),
          'audio',
          { id: hex(8), name: file.name.replace(/\.[^.]+$/, ''), ext, content: file, type: ext === 'mp3' ? 'audio/mpeg' : 'audio/wav' },
          (label) => emit('clips:progress', { filePath, label })
        );
        await idb.put('clips', new Blob([file], { type: file.type }), clip.id).catch(() => {});
        picked.delete(filePath);
        update((c) => c.clips.push(clip));
        return publicState();
      })
    ),
    renameClip: handle(({ id, name }) => {
      update((c) => {
        const clip = c.clips.find((x) => x.id === id);
        if (clip && String(name || '').trim()) clip.name = String(name).trim().slice(0, 80);
      });
      return publicState();
    }),
    deleteClip: handle(({ id }) =>
      serial(async () => {
        const cfg = requireSetup();
        const clip = cfg.clips.find((x) => x.id === id);
        if (!clip) return publicState();
        const c = client();
        await buildAndDeploy(c, cfg.setup, liveAssets(cfg).filter((x) => x.id !== id).map((x) => x.versionSid));
        await deleteAssets(c, cfg.setup, [clip]);
        await idb.del('clips', id).catch(() => {});
        update((x) => (x.clips = x.clips.filter((y) => y.id !== id)));
        return publicState();
      })
    ),
    onClipProgress: on('clips:progress'),
    pathForFile: (file) => (file ? remember(file) : null),

    dropCall: handle(async ({ to, clipId }) => {
      const cfg = requireSetup();
      const clip = cfg.clips.find((x) => x.id === clipId);
      if (!clip) throw new Error('Pick an audio clip first.');
      const number = mustNumber(to);
      const record = cfg.recording.enabled !== false;
      const call = await tw.callAndPlay(client(), cfg.fromNumber, number, clip.url, record);
      if (record) update((c) => c.pendingDrops.push({ callSid: call.sid, number, clipId: clip.id, clipName: clip.name, clipUrl: clip.url, createdAt: new Date().toISOString() }));
      return { ...call, recording: record };
    }),
    callStatus: handle(({ sid }) => tw.getCall(client(), String(sid))),
    hangup: handle(({ sid }) => tw.hangupCall(client(), String(sid))),

    listRecordings: handle(async () => (await loadRecs()).map(recordingView)),
    setRecording: handle(({ enabled }) => {
      update((c) => (c.recording.enabled = !!enabled));
      return publicState();
    }),
    chooseRecordingFolder: handle(() => publicState()),
    openRecordingFolder: handle(() => {}),
    recStart: handle(recStart),
    recChunk: handle(recChunk),
    recStop: handle(recStop),
    revealRecording: handle(shareRecording),
    deleteRecording: handle(deleteRecording),
    dropPending: handle(() => {
      const cutoff = Date.now() - 2 * 864e5;
      const keep = load().pendingDrops.filter((p) => Date.parse(p.createdAt) > cutoff);
      update((c) => (c.pendingDrops = keep));
      return keep.map((p) => p.callSid);
    }),
    dropFetch: handle(dropFetch),
    dropSave: handle(dropSave),

    setBadge: handle(({ count }) => {
      if (!navigator.setAppBadge) return;
      return count ? navigator.setAppBadge(count).catch(() => {}) : navigator.clearAppBadge().catch(() => {});
    }),
    focusWindow: handle(() => window.focus()),

    updateState: handle(() => ({ ...up })),
    checkUpdate: handle(() => checkUpdate({ manual: true })),
    installUpdate: handle(installUpdate),
    onUpdateState: on('update:state'),

    listNumbers: handle(({ accountSid, authToken }) => {
      accountSid = String(accountSid || '').trim();
      authToken = String(authToken || '').trim() || getSecret('authToken');
      if (!/^AC[0-9a-fA-F]{32}$/.test(accountSid) || !authToken) return [];
      return tw.listNumbers(createClient(accountSid, authToken));
    }),
    accountInfo: handle(() => tw.accountInfo(client())),
    // iPhone asks before letting the app read the clipboard, so this only runs from a tap.
    readClipboard: handle(async () => (navigator.clipboard && navigator.clipboard.readText ? (await navigator.clipboard.readText()).slice(0, 4000) : '')),
    openLink: handle(({ url }) => {
      const u = new URL(String(url));
      if (u.protocol === 'https:' || u.protocol === 'http:') window.open(u.toString(), '_blank', 'noopener');
    }),
    openExternal: handle(({ url }) => {
      const u = new URL(String(url));
      const ok = ['twilio.com', 'github.com'].some((d) => u.hostname === d || u.hostname.endsWith('.' + d));
      if (u.protocol === 'https:' && ok) window.open(u.toString(), '_blank', 'noopener');
    }),
  };
})();
