'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const S = {
  state: null,
  messages: [],
  msgSig: '',
  active: null, // number of open conversation
  composingNew: false,
  selectedClip: null,
  pendingUploads: new Map(), // filePath -> label
  device: null,
  call: null,
  callTimer: null,
  drop: null, // { sid, to, clipName, timer }
  history: loadHistory(),
  attachment: null, // { file, url }
  pending: null, // picture message being sent: { to, body, url, label }
  localMedia: {}, // message sid -> local preview URL for pictures sent from here
  media: {}, // message sid -> [data URLs] downloaded from Twilio
  mediaLoading: new Set(),
  seen: new Set(),
  recordings: [],
  freshRec: null, // id of a just-saved recording (animates in)
  lastRead: loadJSON('lastRead', null), // number -> time the conversation was last looked at
  knownSids: null, // message sids seen so far (to spot new incoming texts)
  calls: loadJSON('callHistory', []), // recent calls for the Phone tab
  callLog: null, // the live call in progress, for Recents
  dropFetching: new Set(),
  update: null,
  drafts: loadJSON('drafts', {}), // number -> unsent text
  account: null, // { name, type, balance, currency }
  editingAccount: false,
};

function loadJSON(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Phones and tablets: no hover, and focusing a text box pops up the keyboard.
const TOUCH = matchMedia('(hover: none) and (pointer: coarse)').matches;
const onIOS = () => !!(S.state && S.state.platform === 'ios');
const inFront = () => !document.hidden && (document.hasFocus() || TOUCH);

// ---------- utilities ----------

async function rpc(fn, arg) {
  const r = await fn(arg);
  if (r && r.error) throw new Error(r.error);
  return r ? r.data : undefined;
}

function h(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'html') n.innerHTML = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return n;
}

const ICON = {
  person: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c1.2-3.6 4.1-5.5 7.5-5.5s6.3 1.9 7.5 5.5" stroke-linecap="round"/></svg>',
  phone: '<svg viewBox="0 0 24 24"><path d="M6.6 3.2 8.9 3a1 1 0 0 1 1 .63l1.3 3.2a1 1 0 0 1-.27 1.13L9.2 9.5a11.6 11.6 0 0 0 5.3 5.3l1.54-1.74a1 1 0 0 1 1.13-.27l3.2 1.3a1 1 0 0 1 .63 1l-.2 2.3A2.3 2.3 0 0 1 18.5 19.5 14.5 14.5 0 0 1 4.5 5.5a2.3 2.3 0 0 1 2.1-2.3Z"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l10.5-6.5L8 5.5Z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/></svg>',
  msg: '<svg viewBox="0 0 24 24"><path d="M12 3.5c-4.97 0-9 3.36-9 7.5 0 2.2 1.13 4.17 2.94 5.54-.13 1.34-.7 2.6-1.66 3.55 2.1-.02 3.88-.8 5.02-1.66.86.2 1.76.32 2.7.32 4.97 0 9-3.36 9-7.5S16.97 3.5 12 3.5Z"/></svg>',
  wave: '<svg viewBox="0 0 24 24"><path d="M3 10v4M7 7v10M11 4v16M15 8v8M19 10.5v3" stroke-linecap="round"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h4l2 2.2h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7.5Z"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13" stroke-linecap="round"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M12 15V3.5M7.5 8 12 3.5 16.5 8" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 11H6.5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2H16" stroke-linecap="round"/></svg>',
};

function normalize(raw) {
  raw = String(raw || '').trim();
  const digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? '+' + digits : null;
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return null;
}

function fmt(num) {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(num || '');
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : num || '';
}

const contacts = () => (S.state && S.state.contacts) || {};
const nameFor = (num) => contacts()[num] || fmt(num);
const hasName = (num) => !!contacts()[num];

// "Mom" or "(555) 123-4567" -> E.164
function resolve(input) {
  const q = String(input || '').trim();
  if (!q) return null;
  const byName = Object.entries(contacts()).find(([, n]) => n.toLowerCase() === q.toLowerCase());
  return byName ? byName[0] : normalize(q);
}

const HUES = [212, 262, 290, 330, 8, 28, 150, 186];
function hue(str) {
  let x = 2166136261;
  for (const ch of String(str)) x = Math.imul(x ^ ch.charCodeAt(0), 16777619) >>> 0;
  return HUES[x % HUES.length];
}

function avatar(el, num) {
  el.style.setProperty('--h', hue(num));
  const n = contacts()[num];
  if (n) el.textContent = n.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  else el.innerHTML = ICON.person;
  return el;
}

function when(d) {
  const date = new Date(d);
  const now = new Date();
  const days = Math.floor((new Date(now.toDateString()) - new Date(date.toDateString())) / 864e5);
  if (days === 0) return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (days === 1) return 'Yesterday';
  if (days < 7) return date.toLocaleDateString([], { weekday: 'long' });
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

function toast(msg, type = '') {
  const t = h('div', { class: 'toast ' + type }, msg);
  $('#toasts').append(t);
  setTimeout(() => {
    t.classList.add('leaving');
    setTimeout(() => t.remove(), 420);
  }, type === 'err' ? 7000 : 3500);
}

function mmss(sec) {
  sec = Math.max(0, Math.round(sec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

// ---------- navigation ----------

function show(view) {
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
  if (view === 'phone' && !TOUCH) setTimeout(() => $('#dial-number').focus(), 50);
  if (view === 'recordings') loadRecordings();
  if (view === 'settings') fillAudioDevices();
  if (view === 'messages' && S.active && !S.composingNew) markRead(S.active);
}
$$('.nav-btn').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));

// ---------- state ----------

async function refreshState(next) {
  S.state = next || (await rpc(api.getState));
  const ready = S.state.callingReady;
  $('#settings-dot').hidden = ready;
  $('#setup-chip').textContent = ready ? 'Ready' : S.state.hasToken ? 'Setup not finished' : 'Not set up';
  $('#setup-chip').classList.toggle('ready', ready);
  renderSidebar();
  renderConnect();
  renderPeople();
  renderClips();
  renderConvos();
  renderThread();
  renderRecordingSettings();
  renderRecordings();
}

// ---------- messages ----------

function other(m) {
  return m.direction && m.direction.startsWith('outbound') ? m.to : m.from;
}

function conversations() {
  const map = new Map();
  for (const m of S.messages) {
    const k = other(m);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(m);
  }
  for (const list of map.values()) list.sort((a, b) => new Date(a.date) - new Date(b.date));
  return [...map.entries()]
    .map(([number, msgs]) => ({ number, msgs, last: msgs[msgs.length - 1] }))
    .sort((a, b) => new Date(b.last.date) - new Date(a.last.date));
}

async function loadMessages(quiet = true) {
  if (!S.state || !S.state.hasToken || !S.state.fromNumber) return;
  try {
    const msgs = await rpc(api.listMessages);
    const sig = msgs.map((m) => m.sid + m.status).sort().join();
    if (sig === S.msgSig) return;
    S.msgSig = sig;
    S.messages = msgs;
    noticeIncoming(msgs);
    if (isViewing(S.active)) markRead(S.active, false);
    updateBadges();
    renderConvos();
    renderThread();
    renderPeople();
  } catch (e) {
    if (!quiet) toast(e.message, 'err');
  }
}

// ---------- unread & notifications ----------

const isInbound = (m) => !(m.direction || '').startsWith('outbound');

function isViewing(num) {
  return !!num && inFront() && !S.composingNew && S.active === num && $('#view-messages').classList.contains('active');
}

function lastDate(num) {
  const c = conversations().find((x) => x.number === num);
  return c ? Date.parse(c.last.date) || 0 : 0;
}

function unreadIn(conv) {
  const t = (S.lastRead && S.lastRead[conv.number]) || 0;
  return conv.msgs.filter((m) => isInbound(m) && Date.parse(m.date) > t).length;
}

function markRead(num, render = true) {
  if (!num || !S.lastRead) return;
  S.lastRead[num] = Math.max(Date.now(), lastDate(num));
  saveJSON('lastRead', S.lastRead);
  updateBadges();
  if (render) renderConvos();
}

function updateBadges() {
  if (!S.lastRead) {
    // First run: everything that's already there counts as read.
    S.lastRead = {};
    for (const c of conversations()) S.lastRead[c.number] = Math.max(Date.now(), Date.parse(c.last.date) || 0);
    saveJSON('lastRead', S.lastRead);
  }
  const total = conversations().reduce((n, c) => n + unreadIn(c), 0);
  const b = $('#msg-badge');
  const label = total > 99 ? '99+' : String(total);
  if (total && !b.hidden && b.textContent !== label) Motion.restart(b, 'bump');
  b.hidden = !total;
  b.textContent = label;
  $('#mark-read').hidden = !total;
  api.setBadge({ count: total });
}

function noticeIncoming(msgs) {
  const first = !S.knownSids;
  const fresh = first ? [] : msgs.filter((m) => isInbound(m) && !S.knownSids.has(m.sid) && Date.now() - Date.parse(m.date) < 15 * 60e3);
  S.knownSids = new Set(msgs.map((m) => m.sid));
  for (const m of fresh.slice(-3)) {
    if (isViewing(m.from)) continue;
    try {
      const n = new Notification(nameFor(m.from), { body: m.body || (m.numMedia ? 'Sent a picture' : 'New message') });
      n.onclick = () => {
        api.focusWindow();
        show('messages');
        openConvo(m.from);
      };
    } catch {}
  }
}

window.addEventListener('focus', () => {
  if (isViewing(S.active)) markRead(S.active);
});

function renderConvos() {
  const q = $('#convo-search').value.trim().toLowerCase();
  const list = conversations().filter(
    (c) => !q || nameFor(c.number).toLowerCase().includes(q) || c.number.includes(q.replace(/\D/g, '') || '~') || c.msgs.some((m) => (m.body || '').toLowerCase().includes(q))
  );
  Motion.list(
    $('#convos'),
    list.map((c) =>
      h(
        'li',
        { class: 'convo' + (c.number === S.active && !S.composingNew ? ' active' : '') + (unreadIn(c) ? ' unread' : ''), 'data-key': c.number, onclick: () => openConvo(c.number) },
        avatar(h('div', { class: 'avatar' }), c.number),
        h('div', { class: 'meta' }, h('div', { class: 'top' }, h('span', { class: 'name' }, nameFor(c.number)), h('span', { class: 'time' }, when(c.last.date))), h('div', { class: 'preview' }, c.last.body || (c.last.numMedia || S.localMedia[c.last.sid] ? 'Picture' : ''))),
        unreadIn(c) ? h('span', { class: 'udot', 'aria-label': 'Unread' }) : null
      )
    )
  );
  $('#convos-empty').hidden = list.length > 0 || !!q;
}

function openConvo(number) {
  saveDraft();
  S.active = number;
  S.composingNew = false;
  ta.value = S.drafts[number] || '';
  markRead(number, false);
  renderConvos();
  renderThread();
  sizeComposer();
  if (!TOUCH) $('#compose-text').focus();
}

function renderThread() {
  const showing = S.composingNew || S.active;
  $('#thread-empty').hidden = !!showing;
  $('#bubbles').hidden = !showing;
  $('#composer').hidden = !showing;
  $('#thread-head').hidden = !showing;
  $('#to-row').hidden = !S.composingNew;
  $('#who').hidden = S.composingNew;
  $('#thread-actions').hidden = S.composingNew;
  $('#attach-preview').hidden = !showing || !S.attachment;
  if (!showing) return;

  if (S.composingNew) {
    $('#bubbles').replaceChildren();
    return;
  }
  const num = S.active;
  avatar($('#thread-avatar'), num);
  $('#thread-name').textContent = nameFor(num);
  $('#thread-number').textContent = hasName(num) ? fmt(num) : (TOUCH ? 'Tap' : 'Click') + ' the number to add a name';

  const conv = conversations().find((c) => c.number === num);
  const msgs = conv ? conv.msgs : [];
  const box = $('#bubbles');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const nodes = [];
  let lastDay = '';
  let lastAt = 0;
  msgs.forEach((m, i) => {
    const day = new Date(m.date).toDateString();
    const at = Date.parse(m.date) || 0;
    if (day !== lastDay) {
      lastDay = day;
      nodes.push(h('div', { class: 'day' }, when(m.date)));
    } else if (at - lastAt > 60 * 60e3) {
      nodes.push(h('div', { class: 'day gap' }, new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })));
    }
    lastAt = at;
    const out = m.direction.startsWith('outbound');
    const failed = ['failed', 'undelivered'].includes(m.status);
    const media = m.numMedia > 0 || S.localMedia[m.sid] ? mediaNode(m) : null;
    const cls = `bubble ${out ? 'out' : 'in'}${failed ? ' failed' : ''}${media && !m.body ? ' only-media' : ''}${S.seen.has(m.sid) ? '' : ' new'}`;
    nodes.push(
      h(
        'div',
        { class: cls, title: new Date(m.date).toLocaleString() + (m.body && !TOUCH ? ' · double-click to copy' : ''), ondblclick: () => m.body && copyText(m.body, 'Message copied.') },
        media,
        m.body ? h('div', { class: 'text' }, ...linkify(m.body)) : null
      )
    );
    const isLastOut = out && !msgs.slice(i + 1).some((x) => x.direction.startsWith('outbound'));
    if (failed) {
      const canRetry = out && m.body && !m.numMedia && !S.localMedia[m.sid];
      nodes.push(
        h(
          'div',
          { class: 'receipt err', title: m.errorCode ? `Twilio error ${m.errorCode}` : '' },
          h('span', {}, 'Not delivered: ' + whyFailed(m.errorCode)),
          canRetry ? h('button', { class: 'retry-btn', onclick: () => retrySend(m) }, 'Retry') : null
        )
      );
    }
    else if (isLastOut) nodes.push(h('div', { class: 'receipt' }, { delivered: 'Delivered', sent: 'Sent', queued: 'Sending…', accepted: 'Sending…', sending: 'Sending…' }[m.status] || m.status));
  });
  if (S.pending && S.pending.to === num) {
    const p = S.pending;
    nodes.push(
      h('div', { class: 'bubble out pending new' + (p.body ? '' : ' only-media') }, h('div', { class: 'media' }, imgOrPlaceholder(p.url)), p.body ? h('div', { class: 'text' }, p.body) : null),
      h('div', { class: 'receipt' }, p.label)
    );
  }
  msgs.forEach((m) => S.seen.add(m.sid));
  box.replaceChildren(...nodes);
  if (box.dataset.for !== num) Motion.restart(box, 'swap');
  if (atBottom || box.dataset.for !== num) box.scrollTop = box.scrollHeight;
  box.dataset.for = num;
}

$('#convo-search').addEventListener('input', renderConvos);

// Plain-English reasons for Twilio delivery errors.
const SMS_ERRORS = {
  30034: 'your number isn’t registered for texting yet (A2P 10DLC). Texts go through once your campaign is approved and your number is in its Messaging Service.',
  30032: 'your toll-free number isn’t verified yet.',
  30007: 'the carrier flagged it as spam.',
  30003: 'their phone is off or out of service.',
  30005: 'that number doesn’t exist or is no longer active.',
  30006: 'that number is a landline or can’t get texts.',
  30004: 'the person has blocked texts from your number.',
  30008: 'an unknown carrier error. Try again.',
  30024: 'your number isn’t allowed to send this kind of message (sender not approved).',
  21610: 'they replied STOP. They need to text START to you before you can text them again.',
  21608: 'trial accounts can only text numbers you’ve verified in Twilio.',
  21211: 'that isn’t a valid phone number.',
  21614: 'that number can’t receive texts.',
};
const whyFailed = (code) => SMS_ERRORS[code] || (code ? `error ${code}` : 'unknown reason');

async function retrySend(m) {
  try {
    const sent = await rpc(api.sendSms, { to: m.to, body: m.body });
    S.messages.push(sent);
    renderConvos();
    renderThread();
    toast('Sent again.');
    setTimeout(() => loadMessages(), 2500);
  } catch (e) {
    toast(e.message, 'err');
  }
}

// ---------- pictures ----------

const isImage = (f) => /^image\//.test(f.type) || /\.(heic|heif)$/i.test(f.name || '');

function imgOrPlaceholder(url) {
  return h('img', {
    src: url,
    alt: 'Picture',
    onclick: () => openLightbox(url),
    onerror: (e) => e.target.replaceWith(h('div', { class: 'media-ph' }, 'Photo')),
  });
}

function mediaNode(m) {
  const urls = S.localMedia[m.sid] ? [S.localMedia[m.sid]] : S.media[m.sid];
  if (!urls) {
    loadMedia(m.sid);
    return h('div', { class: 'media' }, h('div', { class: 'media-ph' }, 'Loading picture…'));
  }
  if (!urls.length) return h('div', { class: 'media' }, h('div', { class: 'media-ph' }, 'Picture unavailable'));
  return h('div', { class: 'media' }, urls.map(imgOrPlaceholder));
}

async function loadMedia(sid) {
  if (S.mediaLoading.has(sid)) return;
  S.mediaLoading.add(sid);
  try {
    S.media[sid] = await rpc(api.getMedia, { sid });
  } catch {
    S.media[sid] = [];
  }
  renderThread();
}

function openLightbox(url) {
  $('#lightbox-img').src = url;
  Motion.show($('#lightbox'));
}
$('#lightbox').addEventListener('click', () => Motion.hide($('#lightbox')));
// ---------- keyboard shortcuts ----------

const VIEWS = ['messages', 'phone', 'drops', 'recordings', 'settings'];
const typingIn = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (mod && /^[1-5]$/.test(e.key)) {
    e.preventDefault();
    return show(VIEWS[Number(e.key) - 1]);
  }
  if (mod && k === 'n') {
    e.preventDefault();
    show('messages');
    return $('#new-msg').click();
  }
  if (mod && e.key === '\\') {
    e.preventDefault();
    return $('#side-collapse').click();
  }
  if (mod && k === 'f') {
    e.preventDefault();
    show('messages');
    $('#convo-search').focus();
    return $('#convo-search').select();
  }
  if (e.key === 'Escape') {
    if (!$('#lightbox').hidden) return Motion.hide($('#lightbox'));
    if (!$('#call-keypad').hidden) return $('#call-keys').click();
    if (document.activeElement === $('#convo-search') && $('#convo-search').value) {
      $('#convo-search').value = '';
      return renderConvos();
    }
  }
  // On a call, typing digits presses the keypad.
  if (S.call && !$('#call-sheet').hidden && !mod && /^[0-9*#]$/.test(e.key) && !typingIn(document.activeElement)) {
    S.call.sendDigits(e.key);
    const key = $$('#call-keypad .key').find((b) => $('b', b).textContent === e.key);
    if (key) {
      key.classList.add('pressed');
      setTimeout(() => key.classList.remove('pressed'), 150);
    }
  }
});

function showAttachment(att) {
  S.attachment = att;
  const preview = $('#attach-preview');
  const old = $('#attach-img', preview) || $('.media-ph', preview);
  const img = h('img', { id: 'attach-img', src: att.url, alt: '', onerror: (e) => e.target.replaceWith(h('div', { class: 'media-ph', style: 'width:60px;height:60px;border-radius:12px' }, 'Photo')) });
  old.replaceWith(img);
  $('#attach-name').textContent = att.file.name || 'Picture';
  preview.hidden = false;
  sizeComposer();
}

function setAttachment(file) {
  if (!(S.active || S.composingNew)) return toast('Open a conversation (or tap the pencil) first, then add the picture.');
  if (!isImage(file)) return toast('That isn’t a picture. You can send JPG, PNG, GIF or HEIC.', 'err');
  if (file.type === 'image/gif' && file.size > 5 * 1024 * 1024) return toast('That GIF is over 5 MB, the limit for picture messages.', 'err');
  if (S.attachment) URL.revokeObjectURL(S.attachment.url);
  showAttachment({ file, url: URL.createObjectURL(file) });
  $('#compose-text').focus();
}

function clearAttachment(revoke) {
  if (S.attachment && revoke) URL.revokeObjectURL(S.attachment.url);
  S.attachment = null;
  $('#attach-preview').hidden = true;
  sizeComposer();
}

// Shrinks big JPG/PNG photos to fit the 5 MB picture-message limit.
async function prepareImage(file) {
  const type = file.type || '';
  if ((type === 'image/jpeg' || type === 'image/png') && file.size > 4.5 * 1024 * 1024) {
    const bmp = await createImageBitmap(file);
    let scale = Math.min(1, 2048 / Math.max(bmp.width, bmp.height));
    for (let q = 0.85; ; q -= 0.15) {
      const cv = document.createElement('canvas');
      cv.width = Math.round(bmp.width * scale);
      cv.height = Math.round(bmp.height * scale);
      cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
      const blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', q));
      if (blob.size <= 4.8 * 1024 * 1024 || q < 0.4) return { name: 'picture.jpg', type: 'image/jpeg', bytes: new Uint8Array(await blob.arrayBuffer()) };
      scale *= 0.75;
    }
  }
  return { name: file.name || 'picture', type, bytes: new Uint8Array(await file.arrayBuffer()) };
}

$('#attach-btn').addEventListener('click', () => $('#attach-input').click());
$('#attach-input').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) setAttachment(f);
});
$('#attach-remove').addEventListener('click', () => clearAttachment(true));
$('#compose-text').addEventListener('paste', (e) => {
  const f = [...(e.clipboardData?.files || [])].find(isImage);
  if (f) {
    e.preventDefault();
    setAttachment(f);
  }
});

api.onMmsProgress(({ label }) => {
  if (S.pending) {
    S.pending.label = label;
    renderThread();
  }
});

$('#new-msg').addEventListener('click', () => {
  saveDraft();
  S.composingNew = true;
  S.active = null;
  ta.value = '';
  sizeComposer();
  $('#to-input').value = '';
  renderConvos();
  renderThread();
  $('#to-input').focus();
});

$('#to-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('#compose-text').focus();
  }
});
$('#to-input').setAttribute('list', 'people-list');

// inline rename
$('#thread-name').addEventListener('click', () => {
  const num = S.active;
  if (!num) return;
  const btn = $('#thread-name');
  const input = h('input', { class: 'rename', value: contacts()[num] || '', placeholder: 'Name', style: 'height:30px;border-radius:10px;padding:0 10px;background:rgba(0,0,0,.25);border:1px solid rgba(10,132,255,.8);outline:none' });
  btn.replaceWith(input);
  input.focus();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    input.replaceWith(btn);
    if (save) {
      try {
        await refreshState(await rpc(api.setContact, { number: num, name: input.value }));
      } catch (e) {
        toast(e.message, 'err');
      }
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
});

$('#thread-call').addEventListener('click', () => S.active && startCall(S.active));
$('#thread-drop').addEventListener('click', () => {
  $('#drop-to').value = hasName(S.active) ? contacts()[S.active] : fmt(S.active);
  show('drops');
});

// composer
const ta = $('#compose-text');
function sizeComposer() {
  ta.style.height = 'auto';
  if (ta.scrollHeight > 0) ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
  $('#send-btn').disabled = !ta.value.trim() && !S.attachment;
  renderSegCount();
}
ta.addEventListener('input', () => {
  sizeComposer();
  clearTimeout(ta._draft);
  ta._draft = setTimeout(saveDraft, 400);
});
ta.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('#composer').requestSubmit();
  }
});

$('#composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = ta.value.trim();
  const att = S.attachment;
  if (!body && !att) return;
  const to = S.composingNew ? resolve($('#to-input').value) : S.active;
  if (!to) return toast('Enter a valid phone number or a saved name.', 'err');
  if (att) return sendPicture(to, body, att);
  $('#send-btn').disabled = true;
  try {
    const m = await rpc(api.sendSms, { to, body });
    S.messages.push(m);
    ta.value = '';
    delete S.drafts[to];
    saveJSON('drafts', S.drafts);
    sizeComposer();
    S.composingNew = false;
    S.active = to;
    renderConvos();
    renderThread();
    renderPeople();
    setTimeout(() => loadMessages(), 2500);
  } catch (err) {
    toast(err.message, 'err');
    $('#send-btn').disabled = false;
  }
});

async function sendPicture(to, body, att) {
  if (needsSetup()) return;
  if (S.pending) return toast('Wait for the current picture to finish sending.');
  S.pending = { to, body, url: att.url, label: 'Preparing picture…' };
  ta.value = '';
  clearAttachment(false);
  S.composingNew = false;
  S.active = to;
  renderConvos();
  renderThread();
  try {
    const image = await prepareImage(att.file);
    const m = await rpc(api.sendMms, { to, body, image });
    S.localMedia[m.sid] = att.url;
    S.messages.push(m);
    S.pending = null;
    setTimeout(() => loadMessages(), 2500);
  } catch (err) {
    S.pending = null;
    toast(err.message, 'err');
    ta.value = body;
    if (S.active === to) showAttachment(att);
  }
  sizeComposer();
  renderConvos();
  renderThread();
  renderPeople();
}

// ---------- people (phone tab) ----------

function peopleList() {
  const nums = new Set([...Object.keys(contacts()), ...conversations().map((c) => c.number)]);
  return [...nums].sort((a, b) => (hasName(b) - hasName(a)) || nameFor(a).localeCompare(nameFor(b)));
}

const peopleQuery = () => ($('#people-search') ? $('#people-search').value.trim().toLowerCase() : '');
const matchesPeople = (num) => {
  const q = peopleQuery();
  return !q || nameFor(num).toLowerCase().includes(q) || num.includes(q.replace(/\D/g, '') || '~');
};

function renderPeople() {
  const list = peopleList().filter(matchesPeople);
  const lastText = new Map(conversations().map((c) => [c.number, c.last]));
  Motion.list(
    $('#people'),
    list.map((num) =>
      h(
        'li',
        { class: 'person', 'data-key': num, onclick: () => { $('#dial-number').value = fmt(num); updateDialName(); } },
        avatar(h('div', { class: 'avatar' }), num),
        h(
          'div',
          { class: 'meta' },
          h('div', { class: 'name' }, nameFor(num)),
          hasName(num) ? h('div', { class: 'num' }, fmt(num)) : null,
          lastText.get(num) ? h('div', { class: 'snip' }, (isInbound(lastText.get(num)) ? '' : 'You: ') + (lastText.get(num).body || 'Picture') + ' · ' + when(lastText.get(num).date)) : null
        ),
        h(
          'div',
          { class: 'acts' },
          h('button', { class: 'icon-btn', title: 'Message', html: ICON.msg, onclick: (e) => { e.stopPropagation(); messagePerson(num); } }),
          h('button', { class: 'icon-btn', title: 'Call', html: ICON.phone, onclick: (e) => { e.stopPropagation(); startCall(num); } })
        )
      )
    )
  );
  $('#people-empty').hidden = list.length > 0 || $('#people').hidden;
  $('#people-empty').textContent = peopleQuery() ? 'No one matches that search.' : 'People you text or name show up here.';
  renderRecents();
  renderCallStats();
  $('#people-list').replaceChildren(...Object.values(contacts()).map((n) => h('option', { value: n })));
}

function messagePerson(num) {
  show('messages');
  openConvo(num);
}

// ---------- recents ----------

const CALL_OUTCOME = {
  answered: 'Answered',
  'not-answered': 'No answer',
  declined: 'Declined',
  failed: 'Didn’t connect',
  completed: 'Played',
  busy: 'Busy',
  'no-answer': 'No answer',
  canceled: 'Canceled',
};

function addCall(entry) {
  S.calls = [entry, ...S.calls].slice(0, 200);
  saveJSON('callHistory', S.calls);
  renderRecents();
  renderCallStats();
}

function renderRecents() {
  const calls = S.calls.filter((c) => matchesPeople(c.number));
  $('#clear-recents').hidden = !S.calls.length || $('#recents').hidden;
  Motion.list(
    $('#recents'),
    calls.map((c) => {
      const ok = c.outcome === 'answered' || c.outcome === 'completed';
      const detail = (CALL_OUTCOME[c.outcome] || c.outcome) + (ok && c.duration ? ` · ${mmss(c.duration)}` : '');
      return h(
        'li',
        { class: 'person', 'data-key': String(c.at) + c.number, title: 'Put this number in the dialer', onclick: () => { $('#dial-number').value = fmt(c.number); updateDialName(); } },
        avatar(h('div', { class: 'avatar' }), c.number),
        h(
          'div',
          { class: 'meta' },
          h('div', { class: 'name' }, nameFor(c.number)),
          h('div', { class: 'num tag' + (ok ? '' : ' bad'), html: c.kind === 'clip' ? ICON.wave : ICON.phone }, h('span', {}, c.kind === 'clip' ? `${c.clip || 'Audio'} · ${detail}` : detail))
        ),
        h('div', { class: 'when' }, when(c.at)),
        h('div', { class: 'acts' }, h('button', { class: 'icon-btn', title: 'Call back', html: ICON.phone, onclick: (e) => { e.stopPropagation(); startCall(c.number); } }))
      );
    })
  );
  $('#recents-empty').hidden = calls.length > 0 || $('#recents').hidden;
  $('#recents-empty').textContent = S.calls.length ? 'No calls match that search.' : 'Calls you make show up here.';
}

function sidePanel(tab) {
  const recents = tab === 'recents';
  $('#tab-recents').classList.toggle('on', recents);
  $('#tab-people').classList.toggle('on', !recents);
  $('#recents').hidden = !recents;
  $('#people').hidden = recents;
  saveJSON('phoneTab', tab);
  renderPeople();
}
$('#tab-recents').addEventListener('click', () => sidePanel('recents'));
$('#tab-people').addEventListener('click', () => sidePanel('people'));

// ---------- dialer ----------

const KEYS = [['1', ''], ['2', 'ABC'], ['3', 'DEF'], ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'], ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'], ['*', ''], ['0', '+'], ['#', '']];

function buildKeypad(root, onKey) {
  root.replaceChildren(...KEYS.map(([d, l]) => h('button', { class: 'key', type: 'button', onclick: () => onKey(d) }, h('b', {}, d), h('small', {}, l))));
}

const dial = $('#dial-number');
function updateDialName() {
  const n = resolve(dial.value);
  $('#dial-name').innerHTML = n && hasName(n) ? '' : '&nbsp;';
  if (n && hasName(n)) $('#dial-name').textContent = contacts()[n];
  $('#dial-msg').disabled = !n;
  $('#dial-drop').disabled = !n;
}

// (555) 123-4567 as you type, for US numbers.
function formatTyping(v) {
  if (/[^\d\s()+-]/.test(v) || v.trim().startsWith('+') && !v.trim().startsWith('+1')) return v;
  let d = v.replace(/\D/g, '');
  const one = d.length === 11 && d[0] === '1';
  if (one) d = d.slice(1);
  if (d.length < 4 || d.length > 10) return v;
  const out = d.length <= 6 ? `(${d.slice(0, 3)}) ${d.slice(3)}` : `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  return (one ? '+1 ' : '') + out;
}
buildKeypad($('#keypad'), (d) => {
  dial.value = formatTyping(dial.value + d);
  updateDialName();
});
dial.addEventListener('input', (e) => {
  if (e.inputType && e.inputType.startsWith('insert') && dial.selectionStart === dial.value.length) dial.value = formatTyping(dial.value);
  updateDialName();
});
dial.addEventListener('keydown', (e) => e.key === 'Enter' && startCall(dial.value));
$('#dial-back').addEventListener('click', () => {
  const d = dial.value.replace(/\D/g, '');
  dial.value = /^[\d\s()+-]*$/.test(dial.value) ? formatTyping(d.slice(0, -1)) : dial.value.slice(0, -1);
  if (!d.slice(0, -1)) dial.value = '';
  updateDialName();
});
$('#dial-call').addEventListener('click', () => startCall(dial.value));

// ---------- live calling (Twilio Voice SDK) ----------

async function getDevice() {
  if (S.device) return S.device;
  if (api.loadVoiceSdk) await api.loadVoiceSdk(); // the iPhone version loads calling on first use
  const token = await rpc(api.voiceToken);
  const device = new Twilio.Device(token, { logLevel: 'error', codecPreferences: ['opus', 'pcmu'], closeProtection: false });
  device.on('tokenWillExpire', async () => {
    try {
      device.updateToken(await rpc(api.voiceToken));
    } catch {}
  });
  device.on('error', (err) => toast('Calling error: ' + (err.message || err), 'err'));
  S.device = device;
  applySpeaker();
  return device;
}

function needsSetup() {
  if (S.state && S.state.callingReady) return false;
  toast('Finish setup in Settings first.', 'err');
  show('settings');
  return true;
}

async function startCall(raw) {
  if (S.call) return toast('You’re already on a call.');
  const to = resolve(raw);
  if (!to) return toast('Enter a valid phone number or a saved name.', 'err');
  if (needsSetup()) return;

  const mic = await rpc(api.requestMic).catch(() => false);
  if (!mic) {
    toast(
      onIOS()
        ? 'Glass Phone needs your microphone to call. Tap Allow when asked, or turn it on in Settings → Apps → Safari → Microphone.'
        : 'Glass Phone needs microphone access to call. Turn it on in System Settings → Privacy → Microphone.',
      'err'
    );
    api.openMicSettings();
    return;
  }

  openCallSheet(to);
  try {
    const device = await getDevice();
    S.callLog = { number: to, at: Date.now(), answeredAt: null };
    const micId = loadJSON('micId', 'default');
    const call = await device.connect({ params: { To: to }, rtcConstraints: micId !== 'default' ? { audio: { deviceId: { ideal: micId } } } : undefined });
    S.call = call;
    call.on('ringing', () => setCallStatus('Ringing…'));
    call.on('accept', () => {
      if (S.callLog) S.callLog.answeredAt = Date.now();
      startRecording(call, to);
      const start = Date.now();
      setCallStatus('0:00');
      S.callTimer = setInterval(() => setCallStatus(mmss((Date.now() - start) / 1000)), 500);
    });
    const end = (label) => () => closeCallSheet(label);
    call.on('disconnect', end('Call ended'));
    call.on('cancel', end('Call ended'));
    call.on('reject', () => {
      if (S.callLog) S.callLog.declined = true;
      closeCallSheet('Call declined');
    });
    call.on('error', (err) => {
      toast('Call problem: ' + (err.message || err), 'err');
    });
  } catch (e) {
    toast(e.message, 'err');
    closeCallSheet();
  }
}

function openCallSheet(num) {
  avatar($('#call-avatar'), num).classList.add('xl');
  $('#call-name').textContent = nameFor(num);
  setCallStatus('Calling…');
  $('#call-mute').classList.remove('on');
  $('#call-keypad').hidden = true;
  Motion.show($('#call-sheet'));
}

function setCallStatus(t) {
  $('#call-status').textContent = t;
}

function closeCallSheet(label) {
  stopRecording();
  const log = S.callLog;
  S.callLog = null;
  if (log) {
    const outcome = log.answeredAt ? 'answered' : log.declined ? 'declined' : label ? 'not-answered' : 'failed';
    addCall({ number: log.number, at: log.at, kind: 'live', outcome, duration: log.answeredAt ? Math.round((Date.now() - log.answeredAt) / 1000) : 0 });
  }
  clearInterval(S.callTimer);
  S.callTimer = null;
  S.call = null;
  if (label) {
    setCallStatus(label);
    setTimeout(() => !S.call && Motion.hide($('#call-sheet')), 900);
  } else {
    Motion.hide($('#call-sheet'));
  }
}

$('#call-end').addEventListener('click', () => {
  if (S.call) S.call.disconnect();
  else if (S.device) S.device.disconnectAll();
  closeCallSheet('Call ended');
});
$('#call-mute').addEventListener('click', () => {
  if (!S.call) return;
  const m = !S.call.isMuted();
  S.call.mute(m);
  $('#call-mute').classList.toggle('on', m);
});
$('#call-keys').addEventListener('click', () => {
  $('#call-keypad').hidden = !$('#call-keypad').hidden;
  $('#call-keys').classList.toggle('on', !$('#call-keypad').hidden);
});
buildKeypad($('#call-keypad'), (d) => S.call && S.call.sendDigits(d));

// ---------- audio clips ----------

const player = new Audio();
let playingId = null;
player.addEventListener('timeupdate', () => {
  const bar = playingId && $(`.clip[data-id="${playingId}"] .bar i`);
  if (bar && player.duration) bar.style.width = (100 * player.currentTime) / player.duration + '%';
});
player.addEventListener('ended', () => setPlaying(null));
player.addEventListener('error', () => {
  if (playingId) toast('Couldn’t play that clip. It may still be publishing; try again in a moment.', 'err');
  setPlaying(null);
});

function setPlaying(id) {
  if (playingId) {
    const old = $(`.clip[data-id="${playingId}"]`);
    if (old) {
      $('.play', old).innerHTML = ICON.play;
      $('.bar i', old).style.width = '0';
    }
  }
  playingId = id;
  if (id) recPlayer.pause();
  if (id) $(`.clip[data-id="${id}"] .play`).innerHTML = ICON.pause;
}

const durations = {};
function clipDuration(clip, el) {
  if (durations[clip.id]) return (el.textContent = durations[clip.id]);
  const a = new Audio();
  a.preload = 'metadata';
  a.src = clip.url;
  a.addEventListener('loadedmetadata', () => {
    if (isFinite(a.duration)) el.textContent = durations[clip.id] = mmss(a.duration) + ' · ' + el.dataset.size;
  });
}

function renderClips() {
  const clips = (S.state && S.state.clips) || [];
  if (S.selectedClip && !clips.find((c) => c.id === S.selectedClip)) S.selectedClip = null;
  const rows = clips.map((c) => {
    const size = (c.size / 1024 / 1024).toFixed(1) + ' MB';
    const info = h('div', { class: 'info', 'data-size': size }, size);
    const li = h(
      'li',
      { class: 'clip' + (c.id === S.selectedClip ? ' selected' : ''), 'data-id': c.id, 'data-key': c.id, onclick: () => selectClip(c.id) },
      h('button', {
        class: 'play',
        title: 'Preview',
        html: c.id === playingId ? ICON.pause : ICON.play,
        onclick: (e) => {
          e.stopPropagation();
          if (playingId === c.id) {
            player.pause();
            return setPlaying(null);
          }
          setPlaying(null);
          player.src = c.url;
          player.play().catch(() => {});
          setPlaying(c.id);
        },
      }),
      h('div', { class: 'meta' }, h('div', { class: 'name' }, c.name), info, h('div', { class: 'bar' }, h('i'))),
      h('button', {
        class: 'icon-btn ghost del',
        title: 'Delete',
        html: ICON.trash,
        onclick: async (e) => {
          e.stopPropagation();
          if (!confirm(`Delete “${c.name}”? It will be removed from your Twilio account.`)) return;
          try {
            if (playingId === c.id) {
              player.pause();
              setPlaying(null);
            }
            li.classList.add('pending');
            await refreshState(await rpc(api.deleteClip, { id: c.id }));
            toast('Clip deleted.', 'ok');
          } catch (err) {
            li.classList.remove('pending');
            toast(err.message, 'err');
          }
        },
      })
    );
    clipDuration(c, info);
    return li;
  });
  const pending = [...S.pendingUploads.entries()].map(([fp, label]) =>
    h('li', { class: 'clip pending', 'data-key': 'up:' + fp }, h('div', { class: 'play' }, h('div', { class: 'spinner' })), h('div', { class: 'meta' }, h('div', { class: 'name' }, fp.split(/[\\/]/).pop()), h('div', { class: 'info' }, label)))
  );
  Motion.list($('#clips'), [...rows, ...pending]);
  const sel = clips.find((c) => c.id === S.selectedClip);
  $('#selected-clip').textContent = sel ? sel.name : 'No clip selected';
  $('#selected-clip').classList.toggle('has', !!sel);
}

function selectClip(id) {
  S.selectedClip = id;
  renderClips();
}

async function uploadFiles(paths) {
  if (needsSetup()) return;
  const good = paths.filter((p) => /\.(mp3|wav)$/i.test(p));
  if (good.length < paths.length) toast('Only MP3 and WAV files can be used.', 'err');
  for (const fp of good) {
    S.pendingUploads.set(fp, 'Waiting…');
  }
  renderClips();
  for (const fp of good) {
    try {
      const before = new Set(S.state.clips.map((c) => c.id));
      const st = await rpc(api.uploadClip, { filePath: fp });
      S.pendingUploads.delete(fp);
      await refreshState(st);
      const added = st.clips.find((c) => !before.has(c.id));
      if (added && !S.selectedClip) selectClip(added.id);
      toast('Clip ready to use on calls.', 'ok');
    } catch (e) {
      S.pendingUploads.delete(fp);
      renderClips();
      toast(e.message, 'err');
    }
  }
}

api.onClipProgress(({ filePath, label }) => {
  if (S.pendingUploads.has(filePath)) {
    S.pendingUploads.set(filePath, label);
    renderClips();
  }
});

$('#add-clip').addEventListener('click', async () => uploadFiles(await rpc(api.pickClips)));
$('#dropzone').addEventListener('click', async () => uploadFiles(await rpc(api.pickClips)));
const dz = $('#dropzone');
['dragenter', 'dragover'].forEach((ev) =>
  document.addEventListener(ev, (e) => {
    e.preventDefault();
    if ($('#view-drops').classList.contains('active')) dz.classList.add('over');
  })
);
document.addEventListener('dragover', () => {
  if ($('#view-messages').classList.contains('active') && (S.active || S.composingNew)) $('.thread-panel').classList.add('drag-img');
});
document.addEventListener('dragleave', (e) => !e.relatedTarget && $('.thread-panel').classList.remove('drag-img'));
['dragleave', 'drop'].forEach((ev) =>
  document.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === 'drop' || !e.relatedTarget) dz.classList.remove('over');
  })
);
document.addEventListener('drop', (e) => {
  const files = [...(e.dataTransfer?.files || [])];
  $('.thread-panel').classList.remove('drag-img');
  if (!files.length) return;
  if ($('#view-messages').classList.contains('active')) {
    const img = files.find(isImage);
    if (img) return setAttachment(img);
  }
  show('drops');
  uploadFiles(files.map((f) => api.pathForFile(f)).filter(Boolean));
});

// ---------- call & play ----------

const STEP = { queued: 'calling', initiated: 'calling', ringing: 'ringing', 'in-progress': 'playing', completed: 'done', busy: 'done', 'no-answer': 'done', failed: 'done', canceled: 'done' };
const ORDER = ['calling', 'ringing', 'playing', 'done'];
const OUTCOME = { completed: 'Played and hung up', busy: 'Line busy', 'no-answer': 'No answer', failed: 'Call failed', canceled: 'Canceled' };

function setTracker(status, text) {
  const step = STEP[status] || 'calling';
  const idx = ORDER.indexOf(step);
  $$('.tstep').forEach((el, i) => {
    el.classList.toggle('on', i <= idx);
    el.classList.toggle('now', i === idx && step !== 'done');
  });
  const tr = $('#tracker');
  tr.classList.toggle('ok', status === 'completed');
  tr.classList.toggle('bad', ['busy', 'no-answer', 'failed', 'canceled'].includes(status));
  $('#track-text').textContent = text;
  $('#drop-cancel').hidden = step === 'done';
}

$('#drop-go').addEventListener('click', async () => {
  if (needsSetup()) return;
  const to = resolve($('#drop-to').value);
  if (!to) return toast('Enter a valid phone number or a saved name.', 'err');
  const clip = S.state.clips.find((c) => c.id === S.selectedClip);
  if (!clip) return toast('Pick an audio clip on the left first.', 'err');
  if (S.drop) return toast('Wait for the current call to finish.');

  $('#drop-go').disabled = true;
  $('#tracker').hidden = false;
  setTracker('queued', `Calling ${nameFor(to)}…`);
  try {
    const call = await rpc(api.dropCall, { to, clipId: clip.id });
    S.drop = { sid: call.sid, to, clipName: clip.name, recording: call.recording };
    pollDrop();
  } catch (e) {
    setTracker('failed', e.message);
    $('#drop-go').disabled = false;
  }
});

async function pollDrop() {
  const d = S.drop;
  if (!d) return;
  try {
    const c = await rpc(api.callStatus, { sid: d.sid });
    const label = { queued: 'Calling…', initiated: 'Calling…', ringing: 'Ringing…', 'in-progress': 'Answered: playing your clip…' }[c.status];
    if (label) {
      setTracker(c.status, `${nameFor(d.to)} · ${label}`);
      d.timer = setTimeout(pollDrop, 1500);
      return;
    }
    const outcome = OUTCOME[c.status] || c.status;
    setTracker(c.status, `${nameFor(d.to)} · ${outcome}${c.status === 'completed' && c.duration ? ` (${mmss(c.duration)})` : ''}`);
    addHistory({ to: d.to, clip: d.clipName, status: c.status, at: Date.now() });
    addCall({ number: d.to, at: Date.now(), kind: 'clip', clip: d.clipName, outcome: c.status, duration: c.duration || 0 });
    if (d.recording) fetchDropRecording(d.sid);
    S.drop = null;
    $('#drop-go').disabled = false;
  } catch (e) {
    d.timer = setTimeout(pollDrop, 3000);
  }
}

$('#drop-cancel').addEventListener('click', async () => {
  if (!S.drop) return;
  try {
    await rpc(api.hangup, { sid: S.drop.sid });
  } catch (e) {
    toast(e.message, 'err');
  }
});

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem('dropHistory') || '[]');
  } catch {
    return [];
  }
}

function addHistory(item) {
  S.history = [item, ...S.history].slice(0, 25);
  try {
    localStorage.setItem('dropHistory', JSON.stringify(S.history));
  } catch {}
  renderHistory();
}

function renderHistory() {
  Motion.list(
    $('#drop-history'),
    S.history.map((x) =>
      h(
        'li',
        { 'data-key': String(x.at) },
        h('span', {}, `${nameFor(x.to)} · ${x.clip}`),
        h('span', { class: x.status === 'completed' ? 's-ok' : 's-bad' }, (OUTCOME[x.status] || x.status) + ' · ' + when(x.at))
      )
    )
  );
  $('#history-empty').hidden = S.history.length > 0;
}

// ---------- call recording ----------
// Your mic and the other person's audio go into one Web Audio graph as two channels,
// so the two stems stay sample-aligned. Half-second blocks are streamed to the main
// process, which writes Me.wav, Them.wav and Both.wav.

const REC_RATE = 24000;
let rec = null; // the recording in progress

function toPcm16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const v = Math.max(-1, Math.min(1, f32[i]));
    out[i] = v < 0 ? v * 32768 : v * 32767;
  }
  return new Uint8Array(out.buffer);
}

async function startRecording(call, number) {
  if (rec || !S.state.recording.enabled) return;
  const local = call.getLocalStream && call.getLocalStream();
  const remote = call.getRemoteStream && call.getRemoteStream();
  if (!local || !remote) return toast('This call couldn’t be recorded.', 'err');
  const r = (rec = { chain: Promise.resolve(), done: false, stopping: false });
  try {
    r.ctx = new AudioContext({ sampleRate: REC_RATE });
    await r.ctx.audioWorklet.addModule('recorder-worklet.js');
    r.id = await rpc(api.recStart, { number });
    if (r.stopping) return finishRecording(r);
    // Chromium only feeds a remote call stream into Web Audio while a media element is also playing it.
    r.keep = new Audio();
    r.keep.muted = true;
    r.keep.srcObject = remote;
    r.keep.play().catch(() => {});
    const merger = r.ctx.createChannelMerger(2);
    r.ctx.createMediaStreamSource(local).connect(merger, 0, 0);
    r.ctx.createMediaStreamSource(remote).connect(merger, 0, 1);
    r.node = new AudioWorkletNode(r.ctx, 'two-stem-recorder', {
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'discrete',
    });
    r.node.port.onmessage = ({ data }) => {
      const me = toPcm16(data.me);
      const them = toPcm16(data.them);
      if (me.length) r.chain = r.chain.then(() => rpc(api.recChunk, { id: r.id, me, them })).catch(() => {});
      if (data.final) finishRecording(r);
    };
    merger.connect(r.node);
    r.node.connect(r.ctx.destination); // outputs silence; keeps the recorder running
    await r.ctx.resume();
    if (!r.stopping) $('#call-rec').hidden = false;
  } catch (e) {
    toast('Couldn’t record this call: ' + e.message, 'err');
    if (rec === r) rec = null;
    finishRecording(r);
  }
}

function stopRecording(r = rec) {
  if (!r) return;
  if (rec === r) rec = null;
  $('#call-rec').hidden = true;
  r.stopping = true;
  if (!r.node) return; // still starting up; startRecording finishes it
  r.node.port.postMessage('stop'); // the worklet sends its last block, then finishRecording runs
  r.timeout = setTimeout(() => finishRecording(r), 3000);
}

async function finishRecording(r) {
  if (r.done) return;
  r.done = true;
  clearTimeout(r.timeout);
  try {
    if (r.keep) r.keep.srcObject = null;
    if (r.node) r.node.disconnect();
    if (r.ctx) r.ctx.close();
  } catch {}
  if (!r.id) return;
  await r.chain;
  try {
    const saved = await rpc(api.recStop, { id: r.id });
    if (!saved) return;
    S.recordings = [saved, ...S.recordings.filter((x) => x.id !== saved.id)];
    S.freshRec = saved.id;
    renderRecordings();
    toast(`Call recording saved (${mmss(saved.duration)}). Find it under Recordings.`, 'ok');
  } catch (e) {
    toast('Couldn’t save the call recording: ' + e.message, 'err');
  }
}

// ---------- recordings list ----------

const recPlayer = new Audio();
let recPlaying = null; // id of the recording loaded in recPlayer
const recStem = {}; // id -> 'both' | 'me' | 'them'
const STEM_LABELS = [['both', 'Both', 'You and them together'], ['me', 'Me', 'Just your voice'], ['them', 'Them', 'Just their voice']];

async function loadRecordings() {
  try {
    S.recordings = await rpc(api.listRecordings);
  } catch (e) {
    return toast(e.message, 'err');
  }
  renderRecordings();
}

const recWhen = (d) => new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function renderRecordings() {
  const list = S.recordings;
  $('#rec-count').hidden = !list.length;
  $('#rec-count').textContent = list.length;
  const mac = S.state && S.state.platform === 'darwin';
  Motion.list(
    $('#recs'),
    list.map((r) => {
      const stem = recStem[r.id] || 'both';
      return h(
        'li',
        { class: 'rec' + (r.id === S.freshRec ? ' fresh' : ''), 'data-id': r.id, 'data-key': r.id },
        h('button', { class: 'play', title: 'Play', html: r.id === recPlaying && !recPlayer.paused ? ICON.pause : ICON.play, onclick: () => toggleRec(r) }),
        avatar(h('div', { class: 'avatar' }), r.number),
        h(
          'div',
          { class: 'meta' },
          h('div', { class: 'name' }, nameFor(r.number)),
          h('div', { class: 'info' }, r.kind === 'clip' ? h('span', { class: 'kind' }, `Audio call · ${r.clip || 'clip'} · `) : null, `${recWhen(r.startedAt)} · ${mmss(r.duration)}`),
          h('div', { class: 'bar', onclick: (e) => seekRec(r, e) }, h('i'))
        ),
        h(
          'div',
          { class: 'seg', role: 'group', 'aria-label': 'Which track to play' },
          ...STEM_LABELS.map(([k, label, tip]) =>
            h('button', { class: k === stem ? 'on' : '', title: r.kind === 'clip' && k === 'me' ? 'Just your clip' : tip, onclick: () => pickStem(r, k) }, label)
          )
        ),
        h('button', {
          class: 'icon-btn ghost',
          title: onIOS() ? 'Share or save to Files' : mac ? 'Show in Finder' : 'Show in folder',
          'aria-label': onIOS() ? 'Share' : 'Show in folder',
          html: onIOS() ? ICON.share : ICON.folder,
          onclick: () => rpc(api.revealRecording, { id: r.id }).catch((e) => toast(e.message, 'err')),
        }),
        h('button', { class: 'icon-btn ghost del', title: onIOS() ? 'Delete' : 'Move to Trash', 'aria-label': 'Delete', html: ICON.trash, onclick: () => deleteRec(r) })
      );
    })
  );
  $('#recs-empty').hidden = list.length > 0;
  S.freshRec = null;
  updateRecProgress();
}

function updateRecButtons() {
  $$('.rec').forEach((li) => {
    const icon = li.dataset.id === recPlaying && !recPlayer.paused ? 'pause' : 'play';
    const btn = $('.play', li);
    if (btn.dataset.icon !== icon) {
      btn.dataset.icon = icon;
      btn.innerHTML = ICON[icon];
    }
  });
}

function updateRecProgress() {
  $$('.rec').forEach((li) => {
    const on = li.dataset.id === recPlaying && recPlayer.duration;
    $('.bar i', li).style.width = on ? (100 * recPlayer.currentTime) / recPlayer.duration + '%' : '0';
  });
}

recPlayer.addEventListener('timeupdate', updateRecProgress);
recPlayer.addEventListener('play', updateRecButtons);
recPlayer.addEventListener('pause', updateRecButtons);
recPlayer.addEventListener('ended', () => {
  recPlaying = null;
  updateRecButtons();
  updateRecProgress();
});
recPlayer.addEventListener('error', () => {
  if (!recPlaying) return;
  toast('Couldn’t play that recording. It may have been moved or deleted.', 'err');
  recPlaying = null;
  updateRecButtons();
});

function playRec(r, from = 0) {
  player.pause();
  setPlaying(null);
  recPlaying = r.id;
  recPlayer.src = r.urls[recStem[r.id] || 'both'];
  recPlayer.currentTime = from;
  recPlayer.play().catch(() => {});
  updateRecButtons();
}

function toggleRec(r) {
  if (recPlaying !== r.id) return playRec(r);
  if (recPlayer.paused) recPlayer.play().catch(() => {});
  else recPlayer.pause();
}

function pickStem(r, stem) {
  recStem[r.id] = stem;
  $$(`.rec[data-id="${r.id}"] .seg button`).forEach((b, i) => b.classList.toggle('on', STEM_LABELS[i][0] === stem));
  if (recPlaying === r.id) playRec(r, recPlayer.currentTime); // same spot, other track
}

function seekRec(r, e) {
  const frac = Math.max(0, Math.min(1, e.offsetX / e.currentTarget.clientWidth));
  if (recPlaying === r.id && recPlayer.duration) recPlayer.currentTime = frac * recPlayer.duration;
  else playRec(r, frac * r.duration);
}

async function deleteRec(r) {
  const what = `the call with ${nameFor(r.number)} (${recWhen(r.startedAt)})`;
  if (!confirm(onIOS() ? `Delete ${what}? This can’t be undone.` : `Move ${what} to the Trash?`)) return;
  if (recPlaying === r.id) {
    recPlayer.pause();
    recPlayer.removeAttribute('src');
    recPlaying = null;
  }
  try {
    await rpc(api.deleteRecording, { id: r.id });
    S.recordings = S.recordings.filter((x) => x.id !== r.id);
    renderRecordings();
  } catch (e) {
    toast(e.message, 'err');
  }
}

// Call & play recordings: Twilio recorded their side; add your clip as the "Me" track.
async function fetchDropRecording(callSid) {
  if (S.dropFetching.has(callSid)) return;
  S.dropFetching.add(callSid);
  try {
    let r;
    for (let i = 0; i < 60; i++) {
      r = await rpc(api.dropFetch, { callSid });
      if (!r || !r.wait) break;
      await sleep(5000);
    }
    if (!r || r.wait) return;
    let me = new Uint8Array(0);
    if (r.clipBytes) {
      try {
        me = await decodeClip(r.clipBytes, r.rate);
      } catch {}
    }
    const saved = await rpc(api.dropSave, { token: r.token, me });
    S.recordings = [saved, ...S.recordings.filter((x) => x.id !== saved.id)];
    S.freshRec = saved.id;
    renderRecordings();
    toast(`Audio call recording saved (${mmss(saved.duration)}). Find it under Recordings.`, 'ok');
  } catch (e) {
    toast('Couldn’t save the audio call recording: ' + e.message + ' It will be tried again next time you open the app.', 'err');
  } finally {
    S.dropFetching.delete(callSid);
  }
}

async function decodeClip(bytes, rate) {
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const audio = await new OfflineAudioContext(1, 1, rate).decodeAudioData(data); // resampled to `rate`
  const mono = new Float32Array(audio.length);
  for (let ch = 0; ch < audio.numberOfChannels; ch++) {
    const d = audio.getChannelData(ch);
    for (let i = 0; i < d.length; i++) mono[i] += d[i] / audio.numberOfChannels;
  }
  return toPcm16(mono);
}

function renderRecordingSettings() {
  $('#drop-rec-note').hidden = !S.state.recording.enabled;
  const r = S.state.recording;
  $('#rec-enabled').checked = r.enabled;
  $('#rec-folder').textContent = '\u200e' + r.folder + '\u200e'; // keeps slashes in place in the right-aligned box
  $('#rec-folder').title = r.folder;
}

$('#rec-enabled').addEventListener('change', async (e) => {
  try {
    await refreshState(await rpc(api.setRecording, { enabled: e.target.checked }));
    toast(e.target.checked ? 'Calls will be recorded.' : 'Call recording is off.');
  } catch (err) {
    toast(err.message, 'err');
  }
});
$('#rec-change-folder').addEventListener('click', async () => {
  try {
    await refreshState(await rpc(api.chooseRecordingFolder));
  } catch (e) {
    toast(e.message, 'err');
  }
});
$('#rec-open-folder').addEventListener('click', () => rpc(api.openRecordingFolder).catch((e) => toast(e.message, 'err')));

// ---------- audio devices ----------

async function fillAudioDevices() {
  let devs = [];
  try {
    devs = await navigator.mediaDevices.enumerateDevices();
  } catch {}
  const fill = (sel, kind, key) => {
    const list = devs.filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
    const saved = loadJSON(key, 'default');
    sel.replaceChildren(
      h('option', { value: 'default' }, 'System default'),
      ...list.map((d, i) => h('option', { value: d.deviceId }, d.label || `${kind === 'audioinput' ? 'Microphone' : 'Speaker'} ${i + 1}`))
    );
    sel.value = list.some((d) => d.deviceId === saved) ? saved : 'default';
    return list;
  };
  const mics = fill($('#mic-select'), 'audioinput', 'micId');
  fill($('#speaker-select'), 'audiooutput', 'speakerId');
  $('#audio-hint').textContent =
    mics.length && !mics[0].label ? 'Device names show up after your first call (once the app has microphone access).' : 'Used for calls you make in the app. Changes apply to your next call.';
}

function applySpeaker() {
  const id = loadJSON('speakerId', 'default');
  const d = S.device;
  if (d && d.audio && d.audio.isOutputSelectionSupported) d.audio.speakerDevices.set(id).catch(() => d.audio.speakerDevices.set('default').catch(() => {}));
}

$('#mic-select').addEventListener('change', (e) => saveJSON('micId', e.target.value));
$('#speaker-select').addEventListener('change', (e) => {
  saveJSON('speakerId', e.target.value);
  applySpeaker();
});
if (navigator.mediaDevices) navigator.mediaDevices.addEventListener('devicechange', () => $('#view-settings').classList.contains('active') && fillAudioDevices());

// ---------- updates ----------

let pillDismissed = null;

function renderUpdate(u) {
  S.update = u;
  const v = u.available && u.available.version;
  $('#app-version').textContent = 'Version ' + u.current;
  const text = !u.enabled
    ? 'Automatic updates aren’t set up in this copy.'
    : {
        idle: 'Glass Phone checks for updates automatically.',
        checking: 'Checking for updates…',
        'up-to-date': 'You’re up to date.',
        downloading: `Downloading version ${v}…`,
        ready: `Version ${v} is downloaded. Restart Glass Phone to finish updating.`,
        manual: `Version ${v} is out and needs a fresh install. Download it, then install it over this one.`,
        error: u.error || 'Couldn’t check for updates.',
      }[u.status];
  $('#update-status').textContent = text + (u.available && u.available.notes && ['ready', 'manual', 'downloading'].includes(u.status) ? `\nWhat’s new: ${u.available.notes}` : '');
  $('#update-status').style.whiteSpace = 'pre-line';
  $('#update-status').classList.toggle('err', u.status === 'error');
  $('#update-bar').hidden = u.status !== 'downloading';
  $('#update-bar i').style.width = Math.round((u.progress || 0) * 100) + '%';
  $('#update-check').disabled = !u.enabled || ['checking', 'downloading'].includes(u.status);
  $('#update-check').hidden = u.status === 'ready';
  const go = $('#update-install');
  go.hidden = !['ready', 'manual'].includes(u.status);
  go.textContent = u.status === 'manual' ? 'Download installer' : 'Restart to update';

  const pill = $('#update-pill');
  pill.hidden = !['ready', 'manual'].includes(u.status) || pillDismissed === v;
  $('#update-pill-text').textContent = u.status === 'manual' ? `Glass Phone ${v} is available` : `Glass Phone ${v} is ready`;
  $('#update-pill-go').textContent = u.status === 'manual' ? 'Download' : 'Restart';
}

async function doUpdate() {
  const u = S.update;
  if (!u) return;
  if (u.status === 'manual') return api.openExternal({ url: u.available.page });
  if (S.call || S.drop) return toast('Finish your call first, then restart to update.');
  try {
    await rpc(api.installUpdate);
  } catch (e) {
    toast(e.message, 'err');
  }
}

api.onUpdateState(renderUpdate);
$('#update-install').addEventListener('click', doUpdate);
$('#update-pill-go').addEventListener('click', doUpdate);
$('#update-pill-close').addEventListener('click', () => {
  pillDismissed = S.update && S.update.available && S.update.available.version;
  Motion.hide($('#update-pill'));
});
$('#update-check').addEventListener('click', async () => {
  try {
    const u = await rpc(api.checkUpdate);
    renderUpdate(u);
  } catch (e) {
    toast(e.message, 'err');
  }
});

// ---------- settings ----------

function fillSettings() {
  $('#set-sid').value = S.state.accountSid;
  $('#set-from').value = fmt(S.state.fromNumber);
  $('#set-token').value = '';
  $('#set-token').placeholder = S.state.hasToken ? 'Saved (leave blank to keep)' : 'Paste your Auth Token';
  connectProgress();
}

const stepEls = {};
api.onSetupProgress(({ id, label, state, message }) => {
  let li = stepEls[id];
  if (!li) {
    li = stepEls[id] = h('li', {}, h('span', { class: 'st' }), h('span', { class: 'lbl' }));
    $('#setup-steps').append(li);
  }
  li.className = state;
  $('.st', li).innerHTML = state === 'running' ? '<div class="spinner" style="width:16px;height:16px"></div>' : '';
  const lbl = $('.lbl', li);
  lbl.textContent = label;
  if (message) lbl.append(h('span', { class: 'err-msg' }, message));
});

$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#settings-save');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  $('#setup-steps').replaceChildren();
  for (const k of Object.keys(stepEls)) delete stepEls[k];
  try {
    await refreshState(await rpc(api.saveSettings, { accountSid: $('#set-sid').value, authToken: $('#set-token').value, fromNumber: $('#set-from').value }));
    fillSettings();
    btn.textContent = 'Setting up…';
    await refreshState(await rpc(api.runSetup));
    S.device = null;
    S.editingAccount = false;
    toast('All set! You can text and call now.', 'ok');
    loadMessages(false);
    loadAccount();
    renderConnect();
  } catch (err) {
    toast(err.message, 'err');
    await refreshState().catch(() => {});
  } finally {
    btn.disabled = false;
    connectProgress();
  }
});

$('#setup-reset').addEventListener('click', async () => {
  if (!confirm('Reset setup? The app forgets its calling setup and clip list; nothing is deleted from Twilio. Run “Save & set up” again afterward.')) return;
  try {
    await refreshState(await rpc(api.resetSetup));
    S.device = null;
    $('#setup-steps').replaceChildren();
    toast('Setup reset.');
  } catch (e) {
    toast(e.message, 'err');
  }
});

document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-ext]');
  if (a) {
    e.preventDefault();
    api.openExternal({ url: a.dataset.ext });
  }
});

// ---------- boot ----------

(async function boot() {
  document.body.classList.add(navigator.userAgent.includes('Windows') ? 'win' : 'mac');
  try {
    await refreshState();
  } catch (e) {
    toast(e.message, 'err');
    return;
  }
  fillSettings();
  renderHistory();
  loadRecordings();
  sidePanel(loadJSON('phoneTab', 'recents'));
  renderUpdate(await rpc(api.updateState));
  const seenVersion = loadJSON('seenVersion', null);
  if (seenVersion && seenVersion !== S.state.version) toast(`Glass Phone updated to version ${S.state.version}.`, 'ok');
  saveJSON('seenVersion', S.state.version);
  if (S.state.platform !== 'darwin') $$('[title*="⌘"]').forEach((el) => (el.title = el.title.replace(/⌘/g, 'Ctrl+')));
  if (S.state.platform !== 'darwin') $$('.notes li').forEach((li) => (li.innerHTML = li.innerHTML.replace(/⌘/g, 'Ctrl+')));
  if (S.state.platform !== 'darwin') $$('kbd').forEach((k) => (k.textContent = k.textContent.replace('⌘', 'Ctrl ')));
  rpc(api.dropPending)
    .then((sids) => sids.forEach(fetchDropRecording))
    .catch(() => {});
  sizeComposer();
  applySide();
  if (!S.state.hasToken) show('settings');
  else {
    loadMessages(false);
    loadAccount();
  }
  setInterval(loadAccount, 15 * 60e3);
  // New texts: every 8 seconds while the window is in front, every 20 seconds in the background.
  (async function poll() {
    for (;;) {
      await sleep(inFront() ? 8000 : 20000);
      await loadMessages();
    }
  })();
  window.addEventListener('focus', () => loadMessages());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    loadMessages();
    if (isViewing(S.active)) markRead(S.active);
  });
})();

// ================= 1.4 additions =================

// ---------- small helpers ----------

function copyText(text, msg = 'Copied.') {
  (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
    .then(() => toast(msg, 'ok'))
    .catch(() => toast('Couldn’t copy that.', 'err'));
}

// Turns web links in a message into clickable links (they open in your browser).
function linkify(text) {
  const out = [];
  const re = /\b(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"’”])|\b(www\.[^\s<]+[^\s<.,;:!?)\]'"’”])/gi;
  let last = 0;
  for (let m; (m = re.exec(text)); ) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const url = m[1] || 'https://' + m[2];
    out.push(h('a', { class: 'lnk', href: '#', title: url, onclick: (e) => { e.preventDefault(); e.stopPropagation(); rpc(api.openLink, { url }).catch((err) => toast(err.message, 'err')); } }, m[0]));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// ---------- drafts ----------

function saveDraft() {
  const num = S.active;
  if (!num || S.composingNew) return;
  const v = ta.value;
  if (v.trim()) S.drafts[num] = v;
  else delete S.drafts[num];
  saveJSON('drafts', S.drafts);
}

// ---------- text length: how many texts this message becomes ----------

const GSM = new Set('@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà');
const GSM_EXT = new Set('^{}\\[~]|€');

function smsParts(text) {
  let gsm = true;
  let units = 0;
  for (const ch of text) {
    if (GSM.has(ch)) units += 1;
    else if (GSM_EXT.has(ch)) units += 2;
    else gsm = false;
  }
  if (!gsm) units = text.length; // UTF-16 units
  const single = gsm ? 160 : 70;
  const multi = gsm ? 153 : 67;
  return { gsm, units, single, parts: units <= single ? 1 : Math.ceil(units / multi) };
}

function renderSegCount() {
  const el = $('#seg-count');
  const t = ta.value;
  if (!t || S.attachment) return (el.hidden = true);
  const p = smsParts(t);
  const show = p.parts > 1 || p.units >= p.single - 40;
  el.hidden = !show;
  if (!show) return;
  el.textContent = p.parts > 1 ? `${p.parts} texts` : `${p.units}/${p.single}`;
  el.classList.toggle('warn', p.parts > 1);
  el.title = (p.gsm ? '' : 'Emoji and some symbols fit 70 characters per text instead of 160. ') + (p.parts > 1 ? `This sends as ${p.parts} texts, each billed separately.` : '');
}

// ---------- mark all read, empty-state buttons ----------

$('#mark-read').addEventListener('click', () => {
  const now = Date.now();
  S.lastRead = S.lastRead || {};
  for (const c of conversations()) S.lastRead[c.number] = Math.max(now, Date.parse(c.last.date) || 0);
  saveJSON('lastRead', S.lastRead);
  updateBadges();
  renderConvos();
});
$('#empty-new-msg').addEventListener('click', () => $('#new-msg').click());
$('#thread-empty-new').addEventListener('click', () => $('#new-msg').click());

// ---------- sidebar ----------

const phoneLayout = () => matchMedia('(max-width: 760px)').matches;

function applySide() {
  if (phoneLayout()) {
    document.body.classList.remove('side-mini', 'side-forced');
    return;
  }
  const forced = innerWidth < 1100;
  const mini = forced || loadJSON('sideMini', false);
  const changed = document.body.classList.contains('side-mini') !== mini;
  document.body.classList.toggle('side-mini', mini);
  document.body.classList.toggle('side-forced', forced);
  $('#side-collapse').title = mini ? 'Expand sidebar' : 'Collapse sidebar';
  if (changed) setTimeout(() => dispatchEvent(new Event('resize')), 470); // re-seat the tab indicator
}
let sideTimer;
addEventListener('resize', (e) => {
  if (!e.isTrusted) return;
  clearTimeout(sideTimer);
  sideTimer = setTimeout(applySide, 120);
});
$('#side-collapse').addEventListener('click', () => {
  saveJSON('sideMini', !document.body.classList.contains('side-mini'));
  applySide();
});
$('#side-new-msg').addEventListener('click', () => {
  show('messages');
  $('#new-msg').click();
});
$('#side-dial').addEventListener('click', () => {
  show('phone');
  if (typeof phoneTab === 'function') phoneTab('keypad');
});
$('#my-number').addEventListener('click', () => S.state && S.state.fromNumber && copyText(S.state.fromNumber, 'Your number is copied.'));

function renderSidebar() {
  const st = S.state;
  $('#my-number').textContent = st.fromNumber ? fmt(st.fromNumber) : 'Not connected';
  const line = $('#status-line');
  const offline = !navigator.onLine;
  const [cls, text] = offline ? ['off', 'Offline'] : st.callingReady ? ['ok', 'Connected'] : st.hasToken ? ['', 'Finish setup'] : ['', 'Not connected'];
  line.className = 'status-line ' + cls;
  $('span', line).textContent = text;
  line.title = offline ? 'No internet connection. Texts and calls will work again once you’re back online.' : text;
  renderAccount();
}

const money = (n, cur) => {
  try {
    return new Intl.NumberFormat([], { style: 'currency', currency: cur || 'USD' }).format(n);
  } catch {
    return (cur ? cur + ' ' : '$') + n.toFixed(2);
  }
};

async function loadAccount() {
  if (!S.state || !S.state.hasToken || !navigator.onLine) return;
  try {
    S.account = await rpc(api.accountInfo);
  } catch {
    return;
  }
  renderAccount();
  renderConnect();
}

function renderAccount() {
  const a = S.account;
  const card = $('#acct-card');
  card.hidden = !a || !S.state.hasToken;
  if (!a) return;
  $('#acct-balance').textContent = a.balance == null ? '–' : money(a.balance, a.currency);
  $('#acct-type').textContent = a.type === 'Trial' ? 'Trial account' : 'Paid account';
  card.classList.toggle('low', a.balance != null && a.balance < 5);
  card.title = a.balance != null && a.balance < 5 ? 'Your balance is getting low. Texts and calls stop when it runs out.' : '';
}

// ---------- online / offline ----------

addEventListener('offline', () => {
  renderSidebar();
  toast('You’re offline. Texts and calls will work again once you reconnect.', 'err');
});
addEventListener('online', () => {
  renderSidebar();
  toast('Back online.', 'ok');
  loadMessages();
  loadAccount();
});

// ---------- Phone page: stats, search, quick actions ----------

function renderCallStats() {
  const startToday = new Date(new Date().toDateString()).getTime();
  const weekAgo = Date.now() - 7 * 864e5;
  $('#stat-today').textContent = S.calls.filter((c) => c.at >= startToday).length;
  const talk = S.calls.filter((c) => c.at >= weekAgo && c.kind === 'live').reduce((n, c) => n + (c.duration || 0), 0);
  $('#stat-talk').textContent = talk >= 3600 ? `${Math.floor(talk / 3600)}h ${Math.floor((talk % 3600) / 60)}m` : mmss(talk);
  $('#stat-people').textContent = peopleList().length;
}

$('#people-search').addEventListener('input', renderPeople);
$('#clear-recents').addEventListener('click', () => {
  if (!confirm('Clear your recent calls? This only clears the list in Glass Phone.')) return;
  S.calls = [];
  saveJSON('callHistory', S.calls);
  renderRecents();
  renderCallStats();
});
$('#tab-recents').addEventListener('click', () => ($('#clear-recents').hidden = !S.calls.length));
$('#tab-people').addEventListener('click', () => ($('#clear-recents').hidden = true));

$('#dial-msg').addEventListener('click', () => {
  const n = resolve(dial.value);
  if (!n) return;
  show('messages');
  if (conversations().some((c) => c.number === n)) return openConvo(n);
  $('#new-msg').click();
  $('#to-input').value = hasName(n) ? contacts()[n] : fmt(n);
  if (!TOUCH) ta.focus();
});
$('#dial-drop').addEventListener('click', () => {
  const n = resolve(dial.value);
  if (!n) return;
  $('#drop-to').value = hasName(n) ? contacts()[n] : fmt(n);
  show('drops');
});
$('#dial-paste').addEventListener('click', async () => {
  try {
    const text = await rpc(api.readClipboard);
    const m = /\+?\d[\d\s().-]{6,}\d/.exec(text || '');
    const n = m && normalize(m[0]);
    if (!n) return toast('There’s no phone number on the clipboard.');
    dial.value = n.startsWith('+1') ? formatTyping(n.slice(2)) : n;
    updateDialName();
  } catch (e) {
    toast(e.message, 'err');
  }
});

// ---------- Settings: Connect Twilio ----------
// Twilio doesn't offer "Sign in with Twilio" for personal apps, so this gets as close as
// it can: open the right Twilio page, pick up the Account SID and Auth Token as you copy
// them, list your numbers to choose from, and set everything up with one button.

const SID_RE = /\bAC[0-9a-f]{32}\b/i;
const TOKEN_RE = /(?<![A-Za-z0-9])[0-9a-f]{32}(?![A-Za-z0-9])/;
let numbersFor = '';

function connectProgress() {
  const sid = SID_RE.test($('#set-sid').value.trim());
  const token = !!$('#set-token').value.trim() || (S.state && S.state.hasToken);
  const number = !!normalize($('#set-from').value);
  const steps = $$('.connect-steps li');
  steps[0].classList.toggle('done', sid || token);
  steps[1].classList.toggle('done', sid && token);
  steps[2].classList.toggle('done', sid && token && number);
  const btn = $('#settings-save');
  if (!btn.disabled) btn.textContent = S.state && S.state.callingReady ? 'Save & set up' : 'Connect & set up';
  btn.classList.toggle('ready', sid && token && number && !(S.state && S.state.callingReady && !S.editingAccount));
  if (sid && token) loadNumbers();
}

function takeCredentials(text, quiet) {
  if (!text) return false;
  let got = [];
  const sid = SID_RE.exec(text);
  const token = TOKEN_RE.exec(text.replace(SID_RE, ''));
  if (sid && sid[0] !== $('#set-sid').value.trim()) {
    $('#set-sid').value = sid[0];
    got.push('Account SID');
  }
  if (token && token[0] !== $('#set-token').value.trim()) {
    $('#set-token').value = token[0];
    got.push('Auth Token');
  }
  if (got.length) {
    toast(`Got your ${got.join(' and ')}.`, 'ok');
    connectProgress();
  } else if (!quiet) {
    toast('Copy your Account SID or Auth Token in Twilio first, then tap Paste.');
  }
  return got.length > 0;
}

$('#connect-open').addEventListener('click', () => {
  api.openExternal({ url: 'https://console.twilio.com/' });
  toast('In Twilio, copy your Account SID, then your Auth Token. Glass Phone fills them in.');
});
$('#connect-paste').addEventListener('click', async () => {
  try {
    takeCredentials(await rpc(api.readClipboard), false);
  } catch {
    toast('Couldn’t read the clipboard. Paste into the boxes below instead.', 'err');
  }
});
['#set-sid', '#set-token', '#set-from'].forEach((sel) => $(sel).addEventListener('input', connectProgress));
$('#set-sid').addEventListener('paste', (e) => {
  const t = e.clipboardData && e.clipboardData.getData('text');
  if (t && SID_RE.test(t) && TOKEN_RE.test(t.replace(SID_RE, ''))) {
    e.preventDefault();
    takeCredentials(t, true);
  }
});

// Desktop: watch the clipboard while you're on this screen and not connected yet.
let lastClip = '';
setInterval(async () => {
  if (onIOS() || !S.state || !$('#view-settings').classList.contains('active') || !document.hasFocus()) return;
  if (S.state.callingReady && !S.editingAccount) return;
  try {
    const t = await rpc(api.readClipboard);
    if (t && t !== lastClip) {
      lastClip = t;
      takeCredentials(t, true);
    }
  } catch {}
}, 1200);

async function loadNumbers() {
  const sid = $('#set-sid').value.trim();
  const token = $('#set-token').value.trim();
  const key = sid + ':' + token;
  if (key === numbersFor) return;
  numbersFor = key;
  const hint = $('#numbers-hint');
  hint.textContent = 'Looking up your numbers…';
  let list;
  try {
    list = await rpc(api.listNumbers, { accountSid: sid, authToken: token });
  } catch (e) {
    numbersFor = '';
    hint.textContent = /rejected/.test(e.message) ? 'Twilio didn’t accept that Account SID and Auth Token. Check them.' : e.message;
    return;
  }
  if (key !== numbersFor) return;
  const pick = $('#set-from-pick');
  if (!list.length) {
    pick.hidden = true;
    $('#set-from').hidden = false;
    hint.innerHTML = 'This account has no phone numbers yet. <a href="#" data-ext="https://console.twilio.com/us1/develop/phone-numbers/manage/search">Buy one in Twilio</a>, then come back.';
    return;
  }
  const caps = (n) => [n.voice && 'Voice', n.sms && 'SMS', n.mms && 'MMS'].filter(Boolean).join(', ');
  pick.replaceChildren(
    ...list.map((n) => h('option', { value: n.number }, `${fmt(n.number)}${n.name && n.name !== n.number && !/^\(\d{3}\)/.test(n.name) ? ' · ' + n.name : ''} — ${caps(n) || 'no texting or calling'}`)),
    h('option', { value: '' }, 'Type a number instead…')
  );
  const current = normalize($('#set-from').value);
  const best = list.find((n) => n.number === current) || list.find((n) => n.voice && n.sms) || list[0];
  pick.value = best.number;
  $('#set-from').value = fmt(best.number);
  pick.hidden = false;
  $('#set-from').hidden = true;
  hint.textContent = list.length === 1 ? 'Found your number.' : `Found ${list.length} numbers. Pick the one to use.`;
  connectProgress();
}
$('#set-from-pick').addEventListener('change', (e) => {
  const v = e.target.value;
  $('#set-from').hidden = !!v;
  if (v) $('#set-from').value = fmt(v);
  else {
    $('#set-from').value = '';
    $('#set-from').focus();
  }
  connectProgress();
});

function renderConnect() {
  if (!S.state) return;
  const connected = S.state.callingReady && !S.editingAccount;
  $('#connected').hidden = !connected;
  $('#connect').classList.toggle('tucked', connected);
  $('#settings-form').classList.toggle('tucked', connected);
  $('#setup-steps').hidden = connected;
  if (!connected) return;
  const a = S.account;
  $('#conn-name').textContent = a && a.name ? a.name : 'Connected to Twilio';
  $('#conn-detail').textContent = [fmt(S.state.fromNumber), a && a.type ? a.type + ' account' : null, a && a.balance != null ? money(a.balance, a.currency) + ' balance' : null].filter(Boolean).join(' · ');
}
$('#conn-edit').addEventListener('click', () => {
  S.editingAccount = true;
  renderConnect();
  connectProgress();
  $('#set-sid').focus();
});
