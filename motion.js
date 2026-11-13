'use strict';
// Shared motion for the whole app:
//  - a highlight that follows the pointer across glass controls (--mx / --my)
//  - a soft ripple from wherever you click
//  - the sidebar's liquid indicator that slides between tabs
//  - sliding thumbs for segmented switches (Both/Me/Them, Recents/People)
//  - Motion.list(): rows flow in, and glide to their new spot when the order changes
//  - Motion.hide()/show(): things animate out instead of vanishing
// Everything is skipped when the system asks for reduced motion.
(function () {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const calm = () => reduced.matches;
  const SPRING = 'cubic-bezier(.22,1.2,.36,1)';
  const OUT = 'cubic-bezier(.22,1,.36,1)';

  const PRESSABLE = [
    '.icon-btn', '.pill-btn', '.primary-btn', '.nav-btn', '.key', '.call-btn', '.end-btn', '.round-btn',
    '.send-btn', '.attach-btn', '.play', '.seg button', '.convo', '.person', '.clip', '.rec', '.dropzone', '.switch-row',
  ].join(',');

  // ---- pointer-following highlight ----
  document.addEventListener(
    'pointermove',
    (e) => {
      const el = e.target.closest && e.target.closest(PRESSABLE);
      if (!el) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', e.clientX - r.left + 'px');
      el.style.setProperty('--my', e.clientY - r.top + 'px');
    },
    { passive: true }
  );

  // ---- ripple ----
  document.addEventListener('pointerdown', (e) => {
    if (calm() || e.button !== 0) return;
    const el = e.target.closest && e.target.closest(PRESSABLE);
    if (!el || el.disabled || el.classList.contains('pending')) return;
    let wrap = el.querySelector(':scope > .rp');
    if (!wrap) {
      wrap = document.createElement('span');
      wrap.className = 'rp';
      el.append(wrap);
    }
    const r = el.getBoundingClientRect();
    const size = Math.hypot(r.width, r.height) * 2;
    const dot = document.createElement('i');
    dot.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
    wrap.append(dot);
    dot.addEventListener('animationend', () => dot.remove());
  });

  // ---- sidebar indicator ----
  const sidebar = document.querySelector('.sidebar');
  const glider = document.createElement('span');
  glider.className = 'nav-glider';
  glider.innerHTML = '<i></i>';
  sidebar.prepend(glider);
  let placed = false;
  let lastX = null;
  let lastY = null;

  function moveGlider() {
    const a = sidebar.querySelector('.nav-btn.active');
    if (!a) return;
    const s = sidebar.getBoundingClientRect();
    const r = a.getBoundingClientRect();
    if (!r.width) return;
    const x = r.left - s.left - sidebar.clientLeft; // absolute positions start inside the border
    const y = r.top - s.top - sidebar.clientTop;
    glider.style.width = r.width + 'px';
    glider.style.height = r.height + 'px';
    if (!placed || calm()) {
      glider.style.transition = 'none';
      glider.style.transform = `translate(${x}px, ${y}px)`;
      void glider.offsetWidth;
      glider.style.transition = '';
      placed = true;
    } else if (y !== lastY || x !== lastX) {
      glider.style.transform = `translate(${x}px, ${y}px)`;
      // a quick squash-and-stretch, like a drop of liquid moving
      // (stretches along the direction it travels: down the sidebar, or across the phone's tab bar)
      const across = Math.abs(x - lastX) > Math.abs(y - lastY);
      const s = (a, b) => (across ? `${b} ${a}` : `${a} ${b}`);
      glider.firstChild.animate(
        [{ scale: '1 1' }, { scale: s('0.82', '1.28'), offset: 0.3 }, { scale: s('1.06', '0.94'), offset: 0.65 }, { scale: '1 1' }],
        { duration: 620, easing: OUT }
      );
    }
    lastX = x;
    lastY = y;
  }

  // ---- segmented switches: thumb follows the selected button ----
  function syncSeg(seg) {
    const btns = [...seg.children].filter((b) => b.tagName === 'BUTTON');
    const i = btns.findIndex((b) => b.classList.contains('on'));
    seg.style.setProperty('--n', btns.length || 1);
    seg.style.setProperty('--i', Math.max(0, i));
  }

  // One observer keeps the indicator and the switches in step with the app's own class changes.
  new MutationObserver((muts) => {
    let nav = false;
    const segs = new Set();
    for (const m of muts) {
      const t = m.target;
      if (m.type === 'attributes') {
        if (t.classList.contains('nav-btn')) nav = true;
        else if (t.parentElement && t.parentElement.classList.contains('seg')) segs.add(t.parentElement);
      } else {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.classList.contains('seg')) segs.add(n);
          else if (n.firstElementChild) n.querySelectorAll('.seg').forEach((s) => segs.add(s));
        }
      }
    }
    if (nav) moveGlider();
    segs.forEach(syncSeg);
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });

  addEventListener('resize', () => {
    placed = false;
    moveGlider();
  });
  document.querySelectorAll('.seg').forEach(syncSeg);
  requestAnimationFrame(moveGlider);

  // ---- lists ----
  // Replaces a list's rows. Rows need data-key; new keys flow in (staggered),
  // existing keys glide from their old position to the new one.
  function list(container, nodes) {
    const before = new Map();
    const animate = !calm() && container.offsetParent !== null;
    if (animate) for (const el of container.children) if (el.dataset.key) before.set(el.dataset.key, el.getBoundingClientRect());
    container.replaceChildren(...nodes);
    if (!animate) return;
    let n = 0;
    for (const el of nodes) {
      const k = el.dataset && el.dataset.key;
      if (!k) continue;
      const old = before.get(k);
      if (old) {
        const now = el.getBoundingClientRect();
        const dx = old.left - now.left;
        const dy = old.top - now.top;
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 560, easing: SPRING });
      } else {
        el.animate([{ opacity: 0, transform: 'translateY(12px) scale(.96)' }, { opacity: 1, transform: 'none' }], {
          duration: 520,
          delay: Math.min(n++, 10) * 40,
          easing: SPRING,
          fill: 'backwards',
        });
      }
    }
  }

  // ---- show / hide ----
  const tokens = new WeakMap();
  function hide(el, ms = 340) {
    if (!el || el.hidden) return;
    if (calm()) {
      el.hidden = true;
      return;
    }
    const token = {};
    tokens.set(el, token);
    el.classList.add('leaving');
    setTimeout(() => {
      if (tokens.get(el) !== token) return; // shown again meanwhile
      el.classList.remove('leaving');
      el.hidden = true;
    }, ms);
  }

  function show(el) {
    if (!el) return;
    tokens.delete(el);
    el.classList.remove('leaving');
    el.hidden = false;
  }

  // Re-runs a CSS animation class.
  function restart(el, cls) {
    if (!el || calm()) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }

  window.Motion = { list, hide, show, restart };
})();
