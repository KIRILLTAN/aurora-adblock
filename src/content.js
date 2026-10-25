/**
 * Контент-скрипт: косметическая фильтрация Ghostery (скрытие рекламы, скриптлеты),
 * элементы, скрытые пользователем, и режим «Скрыть элемент».
 */
import { injectCosmetics } from '@ghostery/adblocker-webextension-cosmetics';

const T = (key) => chrome.i18n.getMessage(key) || key;
const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => undefined);

// косметика — ответ фона приходит только для активных страниц
injectCosmetics(window, true, (arg) => send({ action: 'getCosmeticsFilters', ...arg }).then((r) => r || { active: false }));

// ── скрытые пользователем элементы этого сайта ──
function applyHidden(list) {
  let st = document.getElementById('__aurora_hide');
  if (!list || !list.length) { if (st) st.remove(); return; }
  if (!st) {
    st = document.createElement('style');
    st.id = '__aurora_hide';
    const put = () => { if (!st.isConnected) (document.head || document.documentElement).appendChild(st); };
    if (document.documentElement) put(); else document.addEventListener('readystatechange', put, { once: true });
  }
  // каждое правило отдельно: одно неверное не ломает остальные
  st.textContent = list.map((s) => `${s} { display: none !important; }`).join('\n');
}

const loadPrefs = () => send({ type: 'page:prefs' }).then((p) => applyHidden(p ? p.hidden : []));
loadPrefs();

let lastContextTarget = null;
document.addEventListener('contextmenu', (e) => { lastContextTarget = e.target; }, true);

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === 'prefs:changed') loadPrefs();
  if (msg.type === 'picker:start' && window.top === window) startPicker(msg.fromMenu ? lastContextTarget : null);
});

// ── всплывающая подсказка поверх страницы (в закрытом shadow DOM — сайт её не видит и не ломает) ──
function mk(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') el.textContent = v;
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  el.append(...kids);
  return el;
}

function pageToast(text) {
  const host = document.createElement('aurora-toast');
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `div { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); z-index: 2147483647; padding: 9px 16px; border-radius: 12px;
      background: rgba(22, 26, 35, 0.94); color: #eef1f7; font: 600 13px "Segoe UI", system-ui, sans-serif; box-shadow: 0 10px 30px rgba(0,0,0,0.4);
      animation: a 0.25s ease-out; pointer-events: none; }
    @keyframes a { from { opacity: 0; transform: translate(-50%, 10px); } }`;
  root.append(style, mk('div', { text }));
  document.documentElement.appendChild(host);
  setTimeout(() => host.remove(), 2600);
}

// ── устойчивый CSS-селектор для выбранного элемента ──
function cssPathFor(el) {
  const esc = (s) => CSS.escape(s);
  const randomish = (s) => /\d{3,}|[0-9a-f]{8,}|^(is-|has-)|active|hover|focus|selected|open|visible/i.test(s) || s.length > 40;
  const parts = [];
  for (let n = el; n && n.nodeType === 1 && n !== document.documentElement && n !== document.body; n = n.parentElement) {
    if (n.id && !randomish(n.id)) { parts.unshift('#' + esc(n.id)); }
    else {
      let part = n.localName;
      const cls = [...n.classList].filter((c) => !randomish(c)).slice(0, 3);
      if (cls.length) part += cls.map((c) => '.' + esc(c)).join('');
      const parent = n.parentElement;
      if (parent) {
        const sameTag = [...parent.children].filter((x) => x.localName === n.localName);
        const similar = sameTag.filter((x) => cls.every((c) => x.classList.contains(c)));
        if (similar.length > 1) part += `:nth-of-type(${sameTag.indexOf(n) + 1})`;
      }
      parts.unshift(part);
    }
    const sel = parts.join(' > ');
    try { if (document.querySelectorAll(sel).length === 1) return sel; } catch { /* ignore */ }
    if (parts[0].startsWith('#')) break;
  }
  return parts.join(' > ');
}

function startPicker(preselect) {
  if (document.querySelector('aurora-picker')) return;
  const host = document.createElement('aurora-picker');
  const root = host.attachShadow({ mode: 'closed' });
  const pickerStyle = document.createElement('style');
  pickerStyle.textContent = `
    .box { position: fixed; z-index: 2147483646; pointer-events: none; background: rgba(139, 92, 246, 0.18); outline: 2px solid #8b5cf6; border-radius: 3px; transition: all 0.08s ease-out; }
    .bar { position: fixed; z-index: 2147483647; left: 50%; top: 14px; transform: translateX(-50%); display: flex; align-items: center; gap: 10px; max-width: calc(100vw - 32px); box-sizing: border-box;
      padding: 8px 8px 8px 16px; border-radius: 14px; background: rgba(22, 26, 35, 0.96); color: #eef1f7; font: 13px "Segoe UI", system-ui, sans-serif;
      box-shadow: 0 12px 34px rgba(0,0,0,0.45); animation: a 0.2s ease-out; }
    .bar b { font-weight: 650; }
    .bar code { font: 11.5px Consolas, monospace; color: #a7afc1; max-width: 340px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; vertical-align: bottom; }
    .acts { display: flex; gap: 6px; }
    button { height: 30px; padding: 0 12px; border: 0; border-radius: 9px; background: #262c3a; color: #eef1f7; font: 600 12.5px "Segoe UI", system-ui, sans-serif; cursor: pointer; white-space: nowrap; }
    button:hover { background: #333a4b; }
    button.main { background: linear-gradient(135deg, #8b5cf6, #22d3ee); color: #fff; }
    @keyframes a { from { opacity: 0; transform: translate(-50%, -8px); } }`;
  root.append(pickerStyle,
    mk('div', { class: 'box', hidden: true }),
    mk('div', { class: 'bar' },
      mk('span', { class: 'txt' }, mk('b', { text: T('pickerTitle') }), ' ' + T('pickerHint')),
      mk('span', { class: 'acts' }),
      mk('button', { 'data-a': 'cancel', text: T('pickerCancel') })));
  document.documentElement.appendChild(host);
  const box = root.querySelector('.box');
  const txt = root.querySelector('.txt');
  const acts = root.querySelector('.acts');
  let target = null;
  let chosen = null;

  const frame = (el) => {
    if (!el) { box.hidden = true; return; }
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    box.hidden = false;
  };
  const pick = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    return el && el !== host && el !== document.documentElement && el !== document.body ? el : null;
  };
  const onMove = (e) => { if (chosen) return; target = pick(e); frame(target); };
  const block = (e) => { if (e.composedPath().includes(host)) return; e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };
  const onClick = (e) => {
    if (e.composedPath().includes(host)) return;
    block(e);
    if (chosen || !target) return;
    choose(target);
  };
  const choose = (el) => {
    chosen = el;
    frame(el);
    const sel = cssPathFor(el);
    txt.replaceChildren(mk('b', { text: T('pickerConfirm') }), ' ', mk('code', { text: sel }));
    acts.replaceChildren(mk('button', { 'data-a': 'wider', text: T('pickerWider') }), mk('button', { class: 'main', 'data-a': 'hide', text: T('pickerHide') }));
  };
  const finish = () => {
    window.removeEventListener('mousemove', onMove, true);
    for (const t of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup']) window.removeEventListener(t, t === 'click' ? onClick : block, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onScroll, true);
    host.remove();
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(); } };
  const onScroll = () => frame(chosen || target);
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    if (b.dataset.a === 'cancel') finish();
    else if (b.dataset.a === 'wider' && chosen && chosen.parentElement && chosen.parentElement !== document.body) choose(chosen.parentElement);
    else if (b.dataset.a === 'hide' && chosen) {
      const sel = cssPathFor(chosen);
      chosen.style.setProperty('display', 'none', 'important');
      finish();
      await send({ type: 'picker:save', selector: sel });
      pageToast(T('pickerDone'));
    }
  });
  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('click', onClick, true);
  for (const t of ['mousedown', 'mouseup', 'pointerdown', 'pointerup']) window.addEventListener(t, block, true);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', onScroll, true);
  if (preselect && preselect.nodeType === 1 && preselect !== document.body && preselect !== document.documentElement) choose(preselect);
}
