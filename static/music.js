/* music.js: looping background music.
 * Starts playing as soon as the user first touches/clicks the intro (swipe) page.
 * Browsers that block autoplay will always unlock on that first gesture.
 * Has its own Music button, and drains away while the haunting builds dread. */
(() => {
  'use strict';
  const BASE = 1.0;                       // full volume — the file is mastered quiet (~-20 LUFS)
  const a = new Audio('music.mp3');
  a.loop = true; a.preload = 'auto'; a.volume = 0;      // starts buffering immediately
  let cur = 0, duck = 1, muted = false, wanted = false, silentUntil = 0;

  const btn = document.getElementById('musicBtn');
  const label = () => { if (btn) { btn.setAttribute('aria-pressed', String(!muted)); btn.textContent = 'Music: ' + (muted ? 'off' : 'on'); } };
  if (btn) btn.addEventListener('click', () => { muted = !muted; label(); if (!muted && wanted && a.paused) a.play().catch(() => {}); });
  label();

  const cutting = () => performance.now() < silentUntil;
  const goal = () => (!wanted || muted || a.paused || cutting()) ? 0 : BASE * duck;
  setInterval(() => {
    const g = goal(), k = cutting() ? 0.6 : (g < cur ? 0.12 : 0.04);   // a cut is instant, fade-out is a breath, fade-in is slow
    cur += (g - cur) * k; a.volume = Math.min(1, Math.max(0, cur));
  }, 50);

  function play() {
    return a.play().catch(() => {});      // silently fail — the gesture retry below covers it
  }

  // Start music on the very first user interaction with the intro/swipe page
  function onFirstGesture() {
    wanted = true;
    play();
  }
  addEventListener('pointerdown', onFirstGesture, { once: true });
  addEventListener('keydown',     onFirstGesture, { once: true });

  window.__music = {
    start() { wanted = true; if (a.paused) play(); },
    duck(f) { duck = Math.max(0, Math.min(1, f)); },
    unduck() { duck = 1; },
    silence(ms) { silentUntil = performance.now() + ms; },
    state: () => ({ paused: a.paused, time: +a.currentTime.toFixed(2), volume: +a.volume.toFixed(3), muted, duck }),
  };
})();
