import { T, esc, icon, formatNumber, timeAgo, localize, send } from '../ui/common.js';

const $ = (s) => document.querySelector(s);
let tab = null;
let st = null;

function render() {
  if (!st) return;
  const active = st.enabled && !st.allowed;
  $('#logo').className = 'ab-logo' + (st.enabled ? '' : ' off');
  $('#logo').innerHTML = icon(st.enabled ? 'shieldCheck' : 'shieldOff');
  $('#caption').textContent = st.enabled ? T('captionOn') : T('captionOff');
  $('#global').checked = st.enabled;
  $('#num').textContent = formatNumber(active ? st.tab : 0);
  $('#lbl').innerHTML = st.host ? esc(T('blockedOnSite', st.host)) : esc(T('blockedOnPage'));
  $('#total').textContent = formatNumber(st.total);
  $('#site-row').hidden = !st.host;
  $('#site').checked = !st.allowed;
  $('#site').disabled = !st.enabled;
  $('#site-row').classList.toggle('disabled', !st.enabled);
  $('#annoyances').checked = st.annoyances;
  $('#youtube').checked = st.youtube;
  $('#pick').disabled = !st.host;
  const foot = $('#filters');
  foot.className = st.lastError && !st.updating ? 'err' : '';
  foot.textContent = st.updating ? T('updating') : st.lastError ? T('updateError') : T('filtersAge', timeAgo(st.updatedAt));
  foot.title = st.lastError || '';
  $('#update').disabled = st.updating;
}

async function refresh(poll = false) {
  st = await send({ type: 'status', tabId: tab && tab.id, poll });
  render();
}

const reloadTab = () => { if (tab && st && st.host) chrome.tabs.reload(tab.id); };

$('#global').addEventListener('change', async (e) => {
  st = await send({ type: 'set', key: 'enabled', value: e.target.checked, tabId: tab && tab.id });
  render();
  reloadTab();
});
$('#site').addEventListener('change', async (e) => {
  st = await send({ type: 'site', host: st.host, blocked: e.target.checked, tabId: tab && tab.id });
  render();
  reloadTab();
});
$('#annoyances').addEventListener('change', async (e) => {
  st = await send({ type: 'set', key: 'annoyances', value: e.target.checked, tabId: tab && tab.id });
  render();
});
$('#youtube').addEventListener('change', async (e) => {
  st = await send({ type: 'set', key: 'youtube', value: e.target.checked, tabId: tab && tab.id });
  render();
});
$('#update').addEventListener('click', async () => {
  st.updating = true;
  render();
  st = await send({ type: 'update', tabId: tab && tab.id });
  render();
});
$('#pick').addEventListener('click', async () => {
  await send({ type: 'picker', tabId: tab.id });
  window.close();
});
$('#options').addEventListener('click', () => { chrome.runtime.openOptionsPage(); window.close(); });

chrome.runtime.onMessage.addListener((msg) => { if (msg && msg.type === 'status-changed') refresh(); });

localize();
[tab] = await chrome.tabs.query({ active: true, currentWindow: true });
await refresh(true);
// пока окно открыто — подтягиваем свежие цифры
setInterval(() => refresh(true), 5000);
