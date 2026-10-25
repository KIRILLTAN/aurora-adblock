/**
 * Сборка Aurora AdBlock.
 *   node tools/build.mjs               — скачать свежие списки и собрать расширение
 *   node tools/build.mjs --no-download — собрать из скачанных ранее списков (.cache)
 *
 * Результат: extension/ (можно загрузить как распакованное) и dist/aurora-adblock-<версия>.zip (для магазинов).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { FiltersEngine, adsLists, detectFilterType, FilterType } from '@ghostery/adblocker';
import { convertWithAdguard } from '@ghostery/urlfilter2dnr';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'extension');
const DIST = path.join(ROOT, 'dist');
const CACHE = path.join(ROOT, '.cache');
const OFFLINE = process.argv.includes('--no-download');

const PREFIX = 'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets';
const RESOURCES_URL = `${PREFIX}/ublock-origin/resources.json`;
// те же списки, что и в браузере Aurora, разложенные по наборам правил
const GROUPS = {
  ads: adsLists,
  privacy: [`${PREFIX}/easylist/easyprivacy.txt`, `${PREFIX}/ublock-origin/privacy.txt`],
  ru: ['https://easylist-downloads.adblockplus.org/advblock+cssfixes.txt'],
  annoyances: [`${PREFIX}/easylist/easylist-cookie.txt`, `${PREFIX}/ublock-origin/annoyances-others.txt`, `${PREFIX}/ublock-origin/annoyances-cookies.txt`],
};
// Chrome разрешает не более 1000 правил с регулярными выражениями на все включённые наборы
const REGEX_BUDGET = { ads: 450, privacy: 200, ru: 150, annoyances: 150 };
const RESOURCE_TYPES = new Set(['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping',
  'csp_report', 'media', 'websocket', 'webtransport', 'webbundle', 'other']);

const log = (...a) => console.log('•', ...a);

async function download(url) {
  const file = path.join(CACHE, url.replace(/^https?:\/\//, '').replace(/[^\w.-]+/g, '_'));
  if (OFFLINE && fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      fs.mkdirSync(CACHE, { recursive: true });
      fs.writeFileSync(file, text);
      return text;
    } catch (e) {
      if (attempt >= 3) {
        if (fs.existsSync(file)) { log(`не скачался ${url} (${e.message}) — беру из кэша`); return fs.readFileSync(file, 'utf8'); }
        throw new Error(`не удалось скачать ${url}: ${e.message}`);
      }
    }
  }
}

/** Сетевые фильтры из списка; блоки !#if оставляем только для Chromium. */
function networkLines(text) {
  const out = [];
  const stack = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('!#if ')) {
      const cond = line.slice(5).trim();
      stack.push(/^(env_chromium|!env_firefox|!env_safari|!ext_ublock)$/.test(cond) || cond === 'env_mv3');
      continue;
    }
    if (line.startsWith('!#else')) { if (stack.length) stack[stack.length - 1] = !stack[stack.length - 1]; continue; }
    if (line.startsWith('!#endif')) { stack.pop(); continue; }
    if (stack.includes(false)) continue;
    if (!line || line.startsWith('!') || line.startsWith('[')) continue;
    if (detectFilterType(line) === FilterType.NETWORK) out.push(line);
  }
  return out;
}

function isValidRule(rule, redirects) {
  const c = rule.condition || {};
  if (c.resourceTypes && c.resourceTypes.some((t) => !RESOURCE_TYPES.has(t))) return false;
  if (c.excludedResourceTypes && c.excludedResourceTypes.some((t) => !RESOURCE_TYPES.has(t))) return false;
  if (c.urlFilter !== undefined && (!c.urlFilter || /[^\x00-\x7f]/.test(c.urlFilter))) return false;
  if (c.regexFilter && c.regexFilter.length > 2000) return false;
  if (rule.action.type === 'redirect') {
    const p = rule.action.redirect && rule.action.redirect.extensionPath;
    if (p && !redirects.has(p.replace(/^\/redirects\//, ''))) return false;
  }
  if (rule.action.type === 'allowAllRequests' && !(c.resourceTypes || []).every((t) => t === 'main_frame' || t === 'sub_frame')) return false;
  return true;
}

async function buildRules(group, texts, redirects) {
  const lines = [...new Set(texts.flatMap(networkLines))];
  const { rules } = await convertWithAdguard(lines, { resourcesPath: '/redirects' });
  const kept = [];
  // правила вида ||домен^ с одинаковыми условиями склеиваем в одно с requestDomains —
  // так ~130 тыс. фильтров укладываются в 30 тыс. правил, гарантированных Chrome каждому расширению
  const groups = new Map();
  let regex = 0;
  for (const rule of rules) {
    if (!rule || !isValidRule(rule, redirects)) continue;
    if (rule.condition.regexFilter) {
      if (regex >= REGEX_BUDGET[group]) continue;
      regex++;
    }
    const m = /^\|\|([a-z0-9-]+(?:\.[a-z0-9-]+)+)\^$/.exec(rule.condition.urlFilter || '');
    if (m && !rule.condition.requestDomains && !rule.condition.excludedRequestDomains) {
      const { urlFilter, ...rest } = rule.condition;
      const key = JSON.stringify([rule.action, rule.priority || 1, rest]);
      if (!groups.has(key)) groups.set(key, { rule, domains: new Set() });
      groups.get(key).domains.add(m[1]);
      continue;
    }
    kept.push(rule);
  }
  for (const { rule, domains } of groups.values()) {
    const list = [...domains].sort();
    for (let i = 0; i < list.length; i += 5000) {
      const { urlFilter, ...rest } = rule.condition;
      kept.push({ ...rule, condition: { ...rest, requestDomains: list.slice(i, i + 5000) } });
    }
  }
  const out = [];
  const allow = [];
  for (const rule of kept) {
    rule.id = out.length + 1;
    if (rule.action.type === 'allow' || rule.action.type === 'allowAllRequests') allow.push(rule.id);
    out.push(rule);
  }
  log(`${group}: ${lines.length} фильтров → ${out.length} правил (regex ${regex}, исключений ${allow.length})`);
  return { rules: out, allow, count: out.length };
}

function writeRedirects(resources) {
  const dir = path.join(OUT, 'redirects');
  fs.mkdirSync(dir, { recursive: true });
  const names = new Set();
  for (const r of resources.redirects || []) {
    const enc = String(r.contentType || '').split(';')[1];
    const body = enc === 'base64' ? Buffer.from(r.body, 'base64') : Buffer.from(r.body, 'utf8');
    for (const name of [r.name, ...(r.aliases || [])]) {
      if (!/^[\w.-]+$/.test(name)) continue;
      fs.writeFileSync(path.join(dir, name), body);
      names.add(name);
    }
  }
  return names;
}

/**
 * Скриптлеты uBlock как настоящие функции: фон запускает их через chrome.scripting.executeScript
 * в мире страницы, и строгий CSP сайта (YouTube и др.) им не мешает — в отличие от вставки <script>.
 * Каждая функция самодостаточна (зависимости внутри), потому что браузер передаёт в страницу только её текст.
 */
function scriptletsModule(resources) {
  const byName = new Map();
  for (const s of resources.scriptlets || []) for (const n of [s.name, ...(s.aliases || [])]) byName.set(n, s);
  const deps = (s) => {
    const out = new Map();
    const queue = [...(s.dependencies || [])];
    while (queue.length) {
      const name = queue.pop();
      if (out.has(name) || !byName.has(name)) continue;
      const d = byName.get(name);
      out.set(name, d.body);
      queue.push(...(d.dependencies || []));
    }
    return [...out.values()];
  };
  const SHARE_SAFE_SELF = "if (typeof safeSelf === 'function') { if (scriptletGlobals.safeSelf) { safeSelf.safe = scriptletGlobals.safeSelf; } else { scriptletGlobals.safeSelf = safeSelf(); } }";
  const entries = [];
  for (const s of resources.scriptlets || []) {
    if (s.name.endsWith('.fn')) continue;
    const code = [
      "if (typeof scriptletGlobals === 'undefined') { var scriptletGlobals = {}; }",
      ...deps(s),
      SHARE_SAFE_SELF,
      `try { (${s.body})(...args); } catch (e) { /* скриптлет не должен ломать страницу */ }`,
    ].join(';\n');
    entries.push(`${JSON.stringify(s.name)}: { world: ${JSON.stringify(s.executionWorld || 'MAIN')}, fn: function (...args) {\n${code}\n} }`);
  }
  return `export default {\n${entries.join(',\n')}\n};\n`;
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b);
    // скрипты уже собраны esbuild, манифест пишется отдельно
    else if (!e.name.endsWith('.js') && e.name !== 'manifest.json') fs.copyFileSync(a, b);
  }
}

async function main() {
  const t0 = Date.now();
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  log(OFFLINE ? 'списки из кэша' : 'скачиваю списки фильтров…');
  const urls = [...new Set(Object.values(GROUPS).flat())];
  const texts = Object.fromEntries(await Promise.all(urls.map(async (u) => [u, await download(u)])));
  const resourcesText = await download(RESOURCES_URL);
  const resources = JSON.parse(resourcesText);

  // заглушки для перенаправлений ($redirect=noop.js и т.п.)
  const redirects = writeRedirects(resources);

  // сетевые правила declarativeNetRequest
  fs.mkdirSync(path.join(OUT, 'rules'), { recursive: true });
  const allowIds = {};
  const counts = {};
  for (const [group, list] of Object.entries(GROUPS)) {
    const { rules, allow, count } = await buildRules(group, list.map((u) => texts[u]), redirects);
    fs.writeFileSync(path.join(OUT, 'rules', group + '.json'), JSON.stringify(rules));
    allowIds[group] = allow;
    counts[group] = count;
  }
  fs.writeFileSync(path.join(OUT, 'rules', 'allow-ids.json'), JSON.stringify(allowIds));
  const all = Object.values(counts).reduce((x, y) => x + y, 0);
  log(`всего правил: ${all} (гарантированный лимит Chrome — 30000)`);
  if (all > 30000) console.warn('! правил больше 30000 — у части пользователей наборы могут не включиться');

  // движок косметики: без сетевых фильтров (их делает браузер), со скриптлетами uBlock
  fs.mkdirSync(path.join(OUT, 'engine'), { recursive: true });
  const baseText = [...GROUPS.ads, ...GROUPS.privacy, ...GROUPS.ru].map((u) => texts[u]).join('\n');
  const fullText = baseText + '\n' + GROUPS.annoyances.map((u) => texts[u]).join('\n');
  for (const [kind, text] of [['base', baseText], ['full', fullText]]) {
    const engine = FiltersEngine.parse(text, { loadNetworkFilters: false, loadExtendedSelectors: true });
    engine.updateResources(resourcesText, String(resourcesText.length));
    const buf = engine.serialize();
    fs.writeFileSync(path.join(OUT, 'engine', kind + '.bin'), buf);
    log(`движок ${kind}: ${(buf.length / 1024 / 1024).toFixed(1)} МБ`);
  }
  fs.writeFileSync(path.join(OUT, 'engine', 'meta.json'), JSON.stringify({ builtAt: Date.now() }));

  // скрипты
  const scriptletsFile = path.join(CACHE, 'scriptlets.gen.js');
  fs.writeFileSync(scriptletsFile, scriptletsModule(resources));
  await esbuild.build({
    plugins: [{
      name: 'aurora-scriptlets',
      setup(b) { b.onResolve({ filter: /^aurora:scriptlets$/ }, () => ({ path: scriptletsFile })); },
    }],
    entryPoints: {
      background: path.join(SRC, 'background.js'),
      'popup/popup': path.join(SRC, 'popup', 'popup.js'),
      'options/options': path.join(SRC, 'options', 'options.js'),
    },
    outdir: OUT,
    bundle: true,
    format: 'esm',
    target: 'chrome121',
    minify: true,
    legalComments: 'none',
    logLevel: 'warning',
  });
  // контент-скрипты подключаются без type=module — заворачиваем в IIFE
  await esbuild.build({
    entryPoints: { content: path.join(SRC, 'content.js'), youtube: path.join(SRC, 'youtube.js') },
    outdir: OUT,
    bundle: true,
    format: 'iife',
    target: 'chrome121',
    minify: true,
    legalComments: 'none',
    logLevel: 'warning',
  });

  // статика: html, css, переводы, иконки
  copyDir(SRC, OUT);
  const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
  manifest.web_accessible_resources = [{ resources: ['redirects/*'], matches: ['<all_urls>'] }];
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // архив для магазинов
  fs.mkdirSync(DIST, { recursive: true });
  const zip = path.join(DIST, `aurora-adblock-${manifest.version}.zip`);
  fs.rmSync(zip, { force: true });
  // tar из Windows (bsdtar) умеет zip; tar из Git Bash — нет
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'zip';
  if (process.platform === 'win32') execFileSync(tar, ['-a', '-c', '-f', zip, ...fs.readdirSync(OUT)], { cwd: OUT, stdio: 'inherit' });
  else execFileSync('zip', ['-r', '-q', zip, '.'], { cwd: OUT, stdio: 'inherit' });
  // свежий архив — в папку для магазинов, старые версии оттуда убираем
  const kit = path.join(ROOT, 'Загрузить в магазин расширений');
  if (fs.existsSync(kit)) {
    for (const f of fs.readdirSync(kit)) if (/^aurora-adblock-.*\.zip$/.test(f)) fs.rmSync(path.join(kit, f));
    fs.copyFileSync(zip, path.join(kit, path.basename(zip)));
  }
  log(`готово за ${((Date.now() - t0) / 1000).toFixed(0)} с → ${path.relative(ROOT, zip)} (${(fs.statSync(zip).size / 1024 / 1024).toFixed(1)} МБ)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
