/**
 * Рисует иконки расширения (src/icons/*.png) через headless Edge/Chrome.
 *   node tools/make-icons.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src', 'icons');
const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const browser = BROWSERS.find((b) => fs.existsSync(b));
if (!browser) throw new Error('Не найден Edge или Chrome');

// pad — прозрачные поля (у иконки 128 по правилам Chrome Web Store 16 px с каждой стороны)
const svg = (pad) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-pad} ${-pad} ${128 + pad * 2} ${128 + pad * 2}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#8b5cf6"/><stop offset="0.55" stop-color="#6366f1"/><stop offset="1" stop-color="#22d3ee"/>
    </linearGradient>
    <radialGradient id="h" cx="0.25" cy="0.1" r="0.7">
      <stop offset="0" stop-color="#fff" stop-opacity="0.28"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="128" height="128" rx="30" fill="url(#g)"/>
  <rect width="128" height="128" rx="30" fill="url(#h)"/>
  <path d="M64 108s34-15 34-44V36L64 22 30 36v28c0 29 34 44 34 44z" fill="#fff"/>
  <path d="m49 64 10 10 21-21" fill="none" stroke="#7c5cf5" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

// SVG рисуем на canvas нужного размера прямо в браузере и забираем PNG через --dump-dom
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-icons-'));
const sizes = [16, 32, 48, 128];
const jobs = sizes.map((size) => {
  const pad = size === 128 ? 16 : size === 48 ? 2 : 0;
  return { size, src: 'data:image/svg+xml;base64,' + Buffer.from(svg(pad * 128 / (size - pad * 2))).toString('base64') };
});
const html = path.join(tmp, 'icons.html');
fs.writeFileSync(html, `<!doctype html><html><body><pre id="out"></pre><script>
  const jobs = ${JSON.stringify(jobs)};
  Promise.all(jobs.map((j) => new Promise((ok) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = j.size;
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0, j.size, j.size);
      ok([j.size, c.toDataURL('image/png')]);
    };
    img.src = j.src;
  }))).then((r) => { document.getElementById('out').textContent = 'ICONS' + JSON.stringify(r) + 'END'; });
</script></body></html>`);
const dom = execFileSync(browser, ['--headless=new', '--disable-gpu', '--virtual-time-budget=5000',
  `--user-data-dir=${path.join(tmp, 'profile')}`, '--dump-dom', 'file:///' + html.replace(/\\/g, '/')], { encoding: 'utf8', maxBuffer: 64 << 20 });
const m = dom.match(/ICONS(\[\[.*?\]\])END/s);
if (!m) throw new Error('Браузер не отрисовал иконки');
fs.mkdirSync(OUT, { recursive: true });
for (const [size, url] of JSON.parse(m[1])) {
  const png = path.join(OUT, `${size}.png`);
  fs.writeFileSync(png, Buffer.from(url.split(',')[1], 'base64'));
  console.log('•', path.relative(ROOT, png));
}
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* профиль может быть ещё занят */ }
