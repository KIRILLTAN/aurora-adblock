/**
 * Aurora AdBlock — фоновый service worker.
 * Сетевые запросы режет сам браузер по правилам declarativeNetRequest (EasyList, EasyPrivacy,
 * uBlock filters, RU AdList — собраны при сборке). Здесь живёт движок Ghostery для косметики:
 * скрытие рекламных блоков, расширенные селекторы и скриптлеты, как в браузере Aurora.
 */
import { FiltersEngine, adsAndTrackingLists, fullLists, ENGINE_VERSION } from '@ghostery/adblocker';
import { parse } from 'tldts-experimental';
import SCRIPTLETS from 'aurora:scriptlets';

const RU_LISTS = ['https://easylist-downloads.adblockplus.org/advblock+cssfixes.txt'];
const RESOURCES_URL = 'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ublock-origin/resources.json';
const UPDATE_INTERVAL = 24 * 3600 * 1000;
const STATIC_RULESETS = ['ads', 'privacy', 'ru'];
const CACHE = 'aurora-engine';
const ALLOW_PRIORITY = 10_000_000;

const DEFAULTS = {
  enabled: true,
  annoyances: false,
  youtube: true,
  allowlist: [],
  hidden: {},
  total: 0,
};

// ───────────────────────────── настройки ─────────────────────────────
async function getSettings() {
  const s = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...s };
}

const siteKey = (host) => String(host || '').toLowerCase().replace(/^www\./, '');

function hostOf(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? siteKey(u.hostname) : '';
  } catch { return ''; }
}

function isAllowlisted(list, url) {
  const host = hostOf(url);
  if (!host || !list.length) return false;
  return list.some((d) => host === d || host.endsWith('.' + d));
}

// ───────────────────────────── движок косметики ─────────────────────────────
let engine = null;
let engineKind = null;
let engineLoading = null;
let updating = false;

const cacheKey = (kind) => `https://aurora-adblock.local/engine-${kind}-${ENGINE_VERSION}.bin`;

async function readEngine(kind) {
  try {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(cacheKey(kind));
    if (hit) return FiltersEngine.deserialize(new Uint8Array(await hit.arrayBuffer()));
  } catch { /* кэш устарел или повреждён — берём встроенный */ }
  const res = await fetch(chrome.runtime.getURL(`engine/${kind}.bin`));
  return FiltersEngine.deserialize(new Uint8Array(await res.arrayBuffer()));
}

function getEngine() {
  if (engine) return Promise.resolve(engine);
  if (!engineLoading) {
    engineLoading = (async () => {
      const { annoyances } = await getSettings();
      const kind = annoyances ? 'full' : 'base';
      const e = await readEngine(kind);
      engine = e;
      engineKind = kind;
      return e;
    })().finally(() => { engineLoading = null; });
  }
  return engineLoading;
}

async function fetchText(url) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 30000);
  try {
    const res = await fetch(url, { signal: ac.signal, cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

/** Обновляет списки косметических фильтров (раз в сутки или принудительно). */
async function updateFilters(force = false) {
  if (updating) return false;
  const { updatedAt = 0 } = await chrome.storage.local.get('updatedAt');
  if (!force && Date.now() - updatedAt < UPDATE_INTERVAL) return false;
  updating = true;
  broadcastStatus();
  try {
    const { annoyances } = await getSettings();
    const kind = annoyances ? 'full' : 'base';
    const urls = [...(annoyances ? fullLists : adsAndTrackingLists), ...RU_LISTS];
    const texts = await Promise.all(urls.map((u) => fetchText(u).catch(() => null)));
    const lists = texts.filter(Boolean);
    if (lists.length < Math.ceil(urls.length * 0.6)) throw new Error(chrome.i18n.getMessage('errLists'));
    const resources = await fetchText(RESOURCES_URL).catch(() => null);
    const fresh = FiltersEngine.parse(lists.join('\n'), { loadNetworkFilters: false, loadExtendedSelectors: true });
    if (resources) fresh.updateResources(resources, String(resources.length));
    else if (engine) fresh.resources = engine.resources;
    const buf = fresh.serialize();
    const cache = await caches.open(CACHE);
    await cache.put(cacheKey(kind), new Response(buf));
    engine = fresh;
    engineKind = kind;
    await chrome.storage.local.set({ updatedAt: Date.now(), lastError: null });
    return true;
  } catch (e) {
    await chrome.storage.local.set({ lastError: String((e && e.message) || e) });
    return false;
  } finally {
    updating = false;
    broadcastStatus();
  }
}

// ───────────────────────────── сетевые правила ─────────────────────────────
async function applyRules() {
  const s = await getSettings();
  const all = [...STATIC_RULESETS, 'annoyances'];
  const on = s.enabled ? [...STATIC_RULESETS, ...(s.annoyances ? ['annoyances'] : [])] : [];
  await chrome.declarativeNetRequest.updateEnabledRulesets({
    enableRulesetIds: on,
    disableRulesetIds: all.filter((id) => !on.includes(id)),
  });

  // исключения для сайтов — правило «разрешить всё» на главный документ и фреймы сайта
  const old = await chrome.declarativeNetRequest.getDynamicRules();
  const domains = [...new Set(s.allowlist.map(siteKey).filter(Boolean))];
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: old.map((r) => r.id),
    addRules: domains.length ? [{
      id: 1,
      priority: ALLOW_PRIORITY,
      action: { type: 'allowAllRequests' },
      condition: { requestDomains: domains, resourceTypes: ['main_frame', 'sub_frame'] },
    }] : [],
  });

  // на значке — только иконка, без цифр
  await chrome.declarativeNetRequest.setExtensionActionOptions({ displayActionCountAsBadgeText: false });
  await chrome.action.setBadgeText({ text: '' });
}

// ───────────────────────────── счётчики ─────────────────────────────
// Браузер не сообщает о каждом заблокированном запросе, поэтому раз в минуту (и при открытии окна
// расширения) забираем совпавшие правила. Правила-исключения (@@) в счёт не идут.
let allowIds = null;
async function getAllowIds() {
  if (!allowIds) {
    try {
      const res = await fetch(chrome.runtime.getURL('rules/allow-ids.json'));
      const raw = await res.json();
      allowIds = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, new Set(v)]));
    } catch { allowIds = {}; }
  }
  return allowIds;
}

// все изменения счётчиков в chrome.storage.session — по очереди, чтобы опрос и переходы не затирали друг друга
let sessionQueue = Promise.resolve();
const inSession = (fn) => (sessionQueue = sessionQueue.then(fn, fn));

let polling = null;
function pollMatches() {
  if (!polling) polling = inSession(doPoll).finally(() => { polling = null; });
  return polling;
}

// tabs[id] = { at, n }: n блокировок на странице, открытой во вкладке в момент at
async function doPoll() {
  const { lastPoll = 0 } = await chrome.storage.session.get('lastPoll');
  let info;
  try {
    info = await chrome.declarativeNetRequest.getMatchedRules({ minTimeStamp: lastPoll + 1 });
  } catch {
    return false; // превышен лимит вызовов — посчитаем в следующий раз
  }
  const allow = await getAllowIds();
  const { tabs = {}, resets = {} } = await chrome.storage.session.get(['tabs', 'resets']);
  let added = 0;
  let newest = lastPoll;
  for (const m of info.rulesMatchedInfo || []) {
    newest = Math.max(newest, m.timeStamp);
    const { ruleId, rulesetId } = m.rule;
    if (rulesetId === '_dynamic' || rulesetId === '_session') continue;
    if (allow[rulesetId] && allow[rulesetId].has(ruleId)) continue;
    added++;
    const at = resets[m.tabId] || 0;
    if (m.tabId < 0 || m.timeStamp < at) continue; // запрос прежней страницы
    if (!tabs[m.tabId] || tabs[m.tabId].at !== at) tabs[m.tabId] = { at, n: 0 };
    tabs[m.tabId].n++;
  }
  await chrome.storage.session.set({ lastPoll: newest, tabs });
  if (added) {
    const { total = 0 } = await chrome.storage.local.get('total');
    await chrome.storage.local.set({ total: total + added });
  }
  return true;
}

async function tabCount(tabId) {
  const { tabs = {}, resets = {} } = await chrome.storage.session.get(['tabs', 'resets']);
  const t = tabs[tabId];
  return t && t.at === (resets[tabId] || 0) ? t.n : 0;
}

// новая страница во вкладке — счётчик вкладки с нуля; время берём в момент перехода,
// иначе блокировки, случившиеся пока идёт опрос, ушли бы старой странице
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status !== 'loading' || !change.url) return;
  const at = Date.now();
  inSession(async () => {
    const { resets = {} } = await chrome.storage.session.get('resets');
    resets[tabId] = at;
    await chrome.storage.session.set({ resets });
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  inSession(async () => {
    const { tabs = {}, resets = {} } = await chrome.storage.session.get(['tabs', 'resets']);
    delete tabs[tabId];
    delete resets[tabId];
    await chrome.storage.session.set({ tabs, resets });
  });
});

// ───────────────────────────── состояние для окна и настроек ─────────────────────────────
async function status(tabId) {
  const s = await getSettings();
  const { updatedAt = 0, lastError = null } = await chrome.storage.local.get(['updatedAt', 'lastError']);
  let builtAt = 0;
  try { builtAt = (await (await fetch(chrome.runtime.getURL('engine/meta.json'))).json()).builtAt || 0; } catch { /* ignore */ }
  const out = {
    enabled: s.enabled,
    annoyances: s.annoyances,
    youtube: s.youtube,
    allowlist: s.allowlist,
    hidden: s.hidden,
    total: s.total,
    updatedAt: Math.max(updatedAt, builtAt),
    updating,
    lastError,
    tab: 0,
    host: '',
    allowed: false,
  };
  if (tabId != null) {
    out.tab = await tabCount(tabId);
    try {
      const tab = await chrome.tabs.get(tabId);
      out.host = hostOf(tab.url);
      out.allowed = isAllowlisted(s.allowlist, tab.url);
    } catch { /* вкладка закрыта */ }
  }
  return out;
}

function broadcastStatus() {
  chrome.runtime.sendMessage({ type: 'status-changed' }).catch(() => {});
}

async function setSetting(key, value) {
  if (!(key in DEFAULTS) || key === 'total') return;
  await chrome.storage.local.set({ [key]: value });
  if (key === 'enabled' || key === 'allowlist' || key === 'annoyances') await applyRules();
  if (key === 'annoyances') {
    engine = null;
    getEngine().then(() => updateFilters(false));
  }
  broadcastStatus();
}

async function setSite(host, blocked) {
  const h = siteKey(host);
  if (!h) return;
  const { allowlist } = await getSettings();
  const list = new Set(allowlist);
  if (blocked) {
    // убираем и сам сайт, и родительские домены, которые его разрешали
    for (const d of [...list]) if (h === d || h.endsWith('.' + d)) list.delete(d);
  } else list.add(h);
  await setSetting('allowlist', [...list]);
}

// ───────────────────────────── косметика для страниц ─────────────────────────────
async function onCosmetics(msg, sender) {
  const tab = sender.tab;
  if (!tab || tab.id == null || sender.frameId == null) return {};
  const url = sender.url || '';
  if (!/^https?:/.test(url)) return { active: false };
  const s = await getSettings();
  if (!s.enabled || isAllowlisted(s.allowlist, tab.url || url)) return { active: false };

  const e = await getEngine();
  const { hostname = '', domain = '' } = parse(url);
  const frameId = sender.frameId;
  const insert = (css, target) => (css ? chrome.scripting.insertCSS({ target, css, origin: 'USER' }).catch(() => {}) : null);
  const base = { domain: domain || '', hostname: hostname || '', url, classes: msg.classes, hrefs: msg.hrefs, ids: msg.ids,
    callerContext: { tabId: tab.id, frameId } };

  // общие правила скрытия — один раз на страницу и сразу на все фреймы
  if (frameId === 0 && msg.lifecycle === 'start') {
    const r = e.getCosmeticsFilters({ ...base, getBaseRules: true, getInjectionRules: false, getExtendedRules: false,
      getRulesFromDOM: false, getRulesFromHostname: false });
    if (r.active === false) return { active: false };
    insert(r.styles, { tabId: tab.id, allFrames: true });
  }

  const start = msg.lifecycle === 'start';
  const r = e.getCosmeticsFilters({ ...base, getBaseRules: false, getInjectionRules: false, getExtendedRules: start,
    getRulesFromHostname: start, getRulesFromDOM: msg.lifecycle === 'dom-update' });
  if (r.active === false) return { active: false };
  insert(r.styles, { tabId: tab.id, frameIds: [frameId] });
  const scripts = start ? runScriptlets(e, base, { tabId: tab.id, frameIds: [frameId] }) : [];
  return { active: true, scripts, extended: r.extended, styles: '' };
}

/**
 * Скриптлеты сайта запускаем через chrome.scripting в мире страницы — так их не блокирует CSP сайта.
 * Возвращает текст только тех скриптлетов, которых нет в сборке (появились в обновлённых списках):
 * их по-старому вставит контент-скрипт.
 */
function runScriptlets(e, page, target) {
  const { matches } = e.matchCosmeticFilters({ ...page, getRulesFromHostname: true, getRulesFromDOM: false,
    getInjectionRules: true, getExtendedRules: false });
  const fallback = [];
  for (const { filter, exception } of matches) {
    if (!filter || exception !== undefined || !filter.isScriptInject()) continue;
    const parsed = filter.parseScript();
    if (!parsed) continue;
    const name = e.resources.getScriptletCanonicalName(parsed.name) || parsed.name;
    const known = SCRIPTLETS[name];
    if (known) {
      const args = parsed.args.map((a) => { try { return decodeURIComponent(a); } catch { return a; } });
      chrome.scripting.executeScript({ target, world: known.world, injectImmediately: true, func: known.fn, args }).catch(() => {});
    } else {
      const code = filter.getScript(e.resources.getScriptlet.bind(e.resources));
      if (code) fallback.push(code);
    }
  }
  return fallback;
}

async function pagePrefs(sender) {
  const s = await getSettings();
  const pageUrl = (sender.tab && sender.tab.url) || sender.url || '';
  const active = s.enabled && !isAllowlisted(s.allowlist, pageUrl);
  const host = hostOf(sender.url || pageUrl);
  return {
    hidden: Array.isArray(s.hidden[host]) ? s.hidden[host] : [],
    ytAds: active && s.youtube,
  };
}

async function savePicked(sender, selector) {
  const host = hostOf(sender.url || (sender.tab && sender.tab.url));
  const sel = String(selector || '').trim();
  if (!host || !sel || sel.length > 500 || /[{}]/.test(sel)) return false;
  const { hidden } = await getSettings();
  const all = { ...hidden };
  all[host] = [...new Set([...(all[host] || []), sel])].slice(-200);
  await setSetting('hidden', all);
  return true;
}

async function unhide(host, selector) {
  const h = siteKey(host);
  const { hidden } = await getSettings();
  const all = { ...hidden };
  all[h] = (all[h] || []).filter((x) => selector != null && x !== selector);
  if (!all[h].length) delete all[h];
  await setSetting('hidden', all);
}

async function startPicker(tabId, fromMenu = false) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'picker:start', fromMenu }, { frameId: 0 });
  } catch { /* на служебных страницах контент-скрипта нет */ }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const run = async () => {
    switch (msg && (msg.action || msg.type)) {
      case 'getCosmeticsFilters': return onCosmetics(msg, sender);
      case 'page:prefs': return pagePrefs(sender);
      case 'picker:save': return savePicked(sender, msg.selector);
      case 'status':
        if (msg.poll) await pollMatches();
        return status(msg.tabId);
      case 'set': await setSetting(msg.key, msg.value); return status(msg.tabId);
      case 'site': await setSite(msg.host, msg.blocked); return status(msg.tabId);
      case 'unhide': await unhide(msg.host, msg.selector); return status();
      case 'update': await updateFilters(true); return status(msg.tabId);
      case 'picker': await startPicker(msg.tabId); return true;
      default: return undefined;
    }
  };
  run().then(reply, () => reply(undefined));
  return true;
});

// изменения настроек — сразу во все открытые вкладки (скрытые элементы, YouTube)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(changes.hidden || changes.enabled || changes.allowlist || changes.youtube)) return;
  chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }).then((tabs) => {
    for (const t of tabs) chrome.tabs.sendMessage(t.id, { type: 'prefs:changed' }).catch(() => {});
  });
});

// ───────────────────────────── меню и жизненный цикл ─────────────────────────────
function setupMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'hide', title: chrome.i18n.getMessage('menuHide'), contexts: ['page', 'image', 'link', 'frame', 'video'],
      documentUrlPatterns: ['http://*/*', 'https://*/*'] });
    chrome.contextMenus.create({ id: 'site', title: chrome.i18n.getMessage('menuSite'), contexts: ['action'] });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || tab.id == null) return;
  if (info.menuItemId === 'hide') startPicker(tab.id, true);
  if (info.menuItemId === 'site') {
    const s = await getSettings();
    const allowed = isAllowlisted(s.allowlist, tab.url);
    await setSite(hostOf(tab.url), allowed);
    chrome.tabs.reload(tab.id);
  }
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'count') pollMatches();
  if (a.name === 'update') updateFilters(false);
});

async function boot() {
  await applyRules();
  setupMenus();
  await chrome.alarms.create('count', { periodInMinutes: 1 });
  await chrome.alarms.create('update', { periodInMinutes: 180, delayInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.local.get(null);
  const missing = Object.fromEntries(Object.entries(DEFAULTS).filter(([k]) => !(k in cur)));
  if (Object.keys(missing).length) await chrome.storage.local.set(missing);
  await boot();
});

chrome.runtime.onStartup.addListener(boot);

// движок загружаем заранее, чтобы первая страница не ждала
getEngine().catch(() => {});
