import { T, esc, icon, formatNumber, timeAgo, localize, send } from '../ui/common.js';

const $ = (s) => document.querySelector(s);
let st = null;

function render() {
  $('#stat').innerHTML = `<div class="shield ${st.enabled ? '' : 'off'}">${icon(st.enabled ? 'shieldCheck' : 'shieldOff')}</div>
    <div><div class="count">${formatNumber(st.total)}</div><div class="label">${esc(T('totalLabel'))}</div></div>`;
  $('#enabled').checked = st.enabled;
  $('#annoyances').checked = st.annoyances;
  $('#youtube').checked = st.youtube;

  $('#filters-info').textContent = `EasyList, EasyPrivacy, uBlock Origin, RU AdList · ${st.updating ? T('updating') : T('filtersAge', timeAgo(st.updatedAt))}`;
  $('#filters-err').hidden = !st.lastError || st.updating;
  $('#filters-err').textContent = st.lastError ? T('updateError') + ': ' + st.lastError : '';
  $('#update-filters').disabled = st.updating;

  const allow = st.allowlist || [];
  $('#allow-list').innerHTML = allow.length
    ? allow.map((d) => `<li><span>${esc(d)}</span><button class="icon-btn" data-allow-del="${esc(d)}" title="${esc(T('remove'))}">${icon('x')}</button></li>`).join('')
    : `<li class="empty">${esc(T('allowEmpty'))}</li>`;

  const hidden = Object.entries(st.hidden || {}).filter(([, l]) => Array.isArray(l) && l.length);
  $('#hidden-list').innerHTML = hidden.length
    ? hidden.map(([host, list]) => `<div class="site">
        <div class="site-head"><span>${esc(host)}</span><button class="btn sm ghost" data-unhide-all="${esc(host)}">${esc(T('restoreAll'))}</button></div>
        <ul class="list">${list.map((sel) => `<li><span><code>${esc(sel)}</code></span>
          <button class="icon-btn" data-unhide="${esc(host)}" data-sel="${esc(sel)}" title="${esc(T('restore'))}">${icon('x')}</button></li>`).join('')}</ul></div>`).join('')
    : `<div class="empty">${esc(T('hiddenEmpty'))}</div>`;
}

async function refresh() {
  st = await send({ type: 'status' });
  render();
}

for (const key of ['enabled', 'annoyances', 'youtube']) {
  $('#' + key).addEventListener('change', async (e) => {
    st = await send({ type: 'set', key, value: e.target.checked });
    render();
  });
}

$('#update-filters').addEventListener('click', async () => {
  st.updating = true;
  render();
  st = await send({ type: 'update' });
  render();
});

$('#allow-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  let v = $('#allow-input').value.trim().toLowerCase();
  try { if (/^[a-z]+:\/\//.test(v)) v = new URL(v).hostname; } catch { /* оставляем как ввели */ }
  v = v.replace(/^www\./, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9.-]+\.[a-z0-9-]{2,}$/i.test(v) && !/^[\p{L}\d.-]+\.[\p{L}\d-]{2,}$/u.test(v)) {
    $('#allow-input').focus();
    return;
  }
  st = await send({ type: 'site', host: v, blocked: false });
  $('#allow-input').value = '';
  render();
});

document.addEventListener('click', async (e) => {
  const del = e.target.closest('[data-allow-del]');
  if (del) { st = await send({ type: 'site', host: del.dataset.allowDel, blocked: true }); render(); }
  const one = e.target.closest('[data-unhide]');
  if (one) { st = await send({ type: 'unhide', host: one.dataset.unhide, selector: one.dataset.sel }); render(); }
  const all = e.target.closest('[data-unhide-all]');
  if (all) { st = await send({ type: 'unhide', host: all.dataset.unhideAll, selector: null }); render(); }
});

chrome.runtime.onMessage.addListener((msg) => { if (msg && msg.type === 'status-changed') refresh(); });

localize();
$('#foot').textContent = `Aurora AdBlock ${chrome.runtime.getManifest().version} · ${T('poweredBy')}`;
await refresh();
