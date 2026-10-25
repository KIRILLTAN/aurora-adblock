/**
 * Реклама в плеере YouTube: без звука, на максимальной скорости, сразу к концу, нажать «Пропустить».
 * Сетевые фильтры и скриптлеты убирают бóльшую часть рекламы, это — страховка от того, что прорвалось.
 */
let enabled = false;

const loadPrefs = () => chrome.runtime.sendMessage({ type: 'page:prefs' })
  .then((p) => { enabled = !!(p && p.ytAds); })
  .catch(() => {});
loadPrefs();
chrome.runtime.onMessage.addListener((msg) => { if (msg && msg.type === 'prefs:changed') loadPrefs(); });

let mutedByUs = false;
let rateBefore = 1;
let inAd = false;

setInterval(() => {
  if (!enabled) return;
  const player = document.querySelector('#movie_player, .html5-video-player');
  const video = player && player.querySelector('video');
  if (!player || !video) return;
  const ad = player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting');
  if (ad) {
    if (!inAd) { inAd = true; rateBefore = video.playbackRate || 1; mutedByUs = !video.muted; }
    video.muted = true;
    try { if (Number.isFinite(video.duration) && video.duration > 0.5) video.currentTime = video.duration - 0.1; } catch { /* ignore */ }
    try { video.playbackRate = 16; } catch { /* ignore */ }
    const skip = document.querySelector('.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, button[id^="skip-button"], .ytp-ad-skip-button-slot button');
    if (skip) skip.click();
  } else if (inAd) {
    inAd = false;
    try { video.playbackRate = rateBefore; } catch { /* ignore */ }
    if (mutedByUs) video.muted = false;
    mutedByUs = false;
  }
  document.querySelectorAll('.ytp-ad-overlay-close-button').forEach((b) => b.click());
}, 250);
