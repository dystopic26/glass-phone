'use strict';
// Phone-only behaviour for the iPhone version (runs after app.js):
// tab labels, a back button and swipe-back in chats, the Keypad / Recents / People
// switch, a layout that follows the on-screen keyboard, and the Add to Home Screen tip.
(function () {
  const phone = matchMedia('(max-width: 760px)');
  const root = document.documentElement;
  const body = document.body;

  // :active styles only work on iOS when the page listens for touches.
  document.addEventListener('touchstart', () => {}, { passive: true });


  // ---- chats: back button, swipe from the left edge to go back ----
  const msgView = $('#view-messages');
  const head = $('#thread-head');

  function closeThread() {
    if (!S.active && !S.composingNew) return;
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    S.active = null;
    S.composingNew = false;
    renderConvos();
    renderThread();
  }

  head.prepend(
    h('button', {
      class: 'icon-btn ghost back-btn',
      type: 'button',
      'aria-label': 'Back to messages',
      html: '<svg viewBox="0 0 24 24"><path d="M15 4.5 7.5 12l7.5 7.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      onclick: closeThread,
    })
  );

  function syncThread() {
    const open = !head.hidden && phone.matches;
    if (msgView.classList.contains('in-thread') !== open) msgView.classList.toggle('in-thread', open);
    const covering = open && msgView.classList.contains('active');
    if (body.classList.contains('thread-open') !== covering) body.classList.toggle('thread-open', covering);
  }
  new MutationObserver(syncThread).observe(head, { attributes: true, attributeFilter: ['hidden'] });
  new MutationObserver(syncThread).observe(msgView, { attributes: true, attributeFilter: ['class'] });
  phone.addEventListener('change', syncThread);

  let swipe = null;
  msgView.addEventListener(
    'touchstart',
    (e) => {
      const t = e.touches[0];
      swipe = msgView.classList.contains('in-thread') && e.touches.length === 1 && t.clientX < 28 ? { x: t.clientX, y: t.clientY } : null;
    },
    { passive: true }
  );
  msgView.addEventListener(
    'touchend',
    (e) => {
      if (!swipe) return;
      const t = e.changedTouches[0];
      if (t.clientX - swipe.x > 70 && Math.abs(t.clientY - swipe.y) < 60) closeThread();
      swipe = null;
    },
    { passive: true }
  );

  // ---- phone: Keypad / Recents / People ----
  const phoneView = $('#view-phone');
  const TABS = ['keypad', 'recents', 'people'];
  const tabs = h(
    'div',
    { class: 'seg big phone-tabs', role: 'tablist', style: '--n:3;--i:0' },
    ...['Keypad', 'Recents', 'People'].map((label, i) => h('button', { class: i ? '' : 'on', role: 'tab', onclick: () => phoneTab(TABS[i]) }, label))
  );
  phoneView.prepend(tabs);

  function phoneTab(t) {
    [...tabs.children].forEach((b, i) => b.classList.toggle('on', TABS[i] === t));
    phoneView.classList.toggle('show-list', t !== 'keypad');
    if (t !== 'keypad') sidePanel(t);
  }
  // Tapping someone in Recents or People puts their number in the keypad.
  ['#recents', '#people'].forEach((sel) =>
    $(sel).addEventListener('click', (e) => {
      if (phone.matches && e.target.closest('li') && !e.target.closest('button')) phoneTab('keypad');
    })
  );

  const dial = $('#dial-number');
  if (TOUCH) dial.setAttribute('inputmode', 'none'); // use the on-screen keypad, not the keyboard

  // ---- small touch-ups for the phone ----
  $('#attach-input').setAttribute('accept', 'image/*'); // iOS hands over photos as JPEG
  $('#compose-text').setAttribute('enterkeyhint', 'send');
  $('#dropzone div').innerHTML = '<strong>Add an MP3 or WAV</strong><br><span>Tap to choose from Files · up to 20 MB</span>';
  $$('.notes li').forEach((li) => /Shortcuts/.test(li.textContent) && li.remove());
  $('.rec-side .stem-list').after(h('p', { class: 'hint small web-note' }, 'Recordings are kept in this app. Tap the share button on one to save its three tracks to Files or send them.'));
  if (TOUCH || !('setSinkId' in HTMLMediaElement.prototype)) $('#speaker-select').closest('.field').hidden = true; // iPhone picks the speaker itself
  $('#audio-hint').textContent = 'Used for calls you make in the app.';

  // ---- keep the layout above the on-screen keyboard ----
  const vv = window.visualViewport;
  let raf = 0;
  function fit() {
    raf = 0;
    if (!vv) return;
    root.style.setProperty('--app-h', vv.height + 'px');
    root.style.setProperty('--vv-top', vv.offsetTop + 'px');
    const kb = Math.max(window.innerHeight, root.clientHeight) - vv.height > 140 && typingIn(document.activeElement);
    if (body.classList.contains('kb') !== kb) body.classList.toggle('kb', kb);
  }
  const queueFit = () => raf || (raf = requestAnimationFrame(fit));
  if (vv) {
    vv.addEventListener('resize', queueFit);
    vv.addEventListener('scroll', queueFit);
  }
  // iOS can report a wrong height for a moment while a Home Screen app opens or comes
  // back from the background, so measure again once things settle.
  ['orientationchange', 'pageshow', 'focusout'].forEach((ev) => window.addEventListener(ev, () => setTimeout(queueFit, 300)));
  document.addEventListener('visibilitychange', () => !document.hidden && setTimeout(queueFit, 300));
  fit();
  setTimeout(queueFit, 500);
  // When the keyboard opens in a chat, keep the newest messages in view.
  $('#compose-text').addEventListener('focus', () => setTimeout(() => ($('#bubbles').scrollTop = $('#bubbles').scrollHeight), 350));

  // ---- Add to Home Screen tip (in Safari, before it's installed) ----
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const native = /GlassPhoneNative/.test(navigator.userAgent); // the installed iPhone app
  if (native) document.documentElement.classList.add('native');
  if (ios && !standalone && !native && !loadJSON('installTipClosed', false)) {
    const SHARE = '<svg class="inline" viewBox="0 0 24 24"><path d="M12 15V3.5M7.5 8 12 3.5 16.5 8" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 11H6.5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2H16" stroke-linecap="round"/></svg>';
    const tip = h(
      'div',
      { class: 'install-tip glass', role: 'note' },
      h('img', { src: 'icons/apple-touch-icon.png', alt: '' }),
      h('p', { html: `<strong>Install Glass Phone</strong><br>Tap ${SHARE} Share, then <strong>Add to Home Screen</strong>.` }),
      h('button', {
        class: 'icon-btn ghost',
        'aria-label': 'Close',
        html: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" stroke-linecap="round"/></svg>',
        onclick: () => {
          saveJSON('installTipClosed', true);
          Motion.hide(tip);
        },
      })
    );
    body.append(tip);
  }
})();
