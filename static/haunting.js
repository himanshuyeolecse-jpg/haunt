/* haunting.js: seven "the machine is haunted" events, one every 30 seconds.
 * Browser-only and reversible: no files are read, no commands run, the camera is never recorded.
 * Halloween mode only. Esc leaves the current event instantly. */
(() => {
  'use strict';
  const PERIOD = 30000;           // the quiet time that always follows an event
  const JITTER = 5000;            // plus a random 0-5 s, so you can never time it exactly
  const DEBUG = location.search.includes('debug');   // ?debug shows the real countdown
  const gap = () => PERIOD + Math.random() * JITTER;
  const $ = s => document.querySelector(s);
  const btn = $('#hauntBtn'), nextEl = $('#hauntNext');
  let speed = 1;                  // test hook: >1 makes events run faster
  const lerp = (a, b, t) => a + (b - a) * t;
  const hv = () => (window.__haunt && window.__haunt.dir) ? window.__haunt : null;   // the scene's director hooks
  let facts = {}, escPressed = false, launched = 0, lastIdx = -1;

  const style = document.createElement('style');
  style.textContent = `
  #hlayer{position:fixed;inset:0;z-index:40;display:grid;place-items:center;opacity:0;transition:opacity .35s;
    font-family:ui-monospace,Menlo,Consolas,"Courier New",monospace;color:#8fffb0}
  #hlayer.in{opacity:1}
  #hlayer[hidden]{display:none}
  #hlayer.hfull{background:#02060a;place-items:start stretch;padding:max(24px,5vh) max(20px,6vw)}
  #hlayer.hfull::after{content:"";position:absolute;inset:0;pointer-events:none;
    background:repeating-linear-gradient(to bottom,rgba(0,0,0,0) 0 2px,rgba(0,0,0,.28) 2px 3px)}
  #hlayer.hpanel{background:rgba(0,0,0,.62)}
  #hlayer.hdim{background:rgba(0,0,0,.92)}
  .hpre{margin:0;white-space:pre-wrap;font-size:clamp(13px,1.9vw,18px);line-height:1.55;text-shadow:0 0 8px rgba(120,255,160,.45)}
  .hwarn{color:#ff5a4d;text-shadow:0 0 8px rgba(255,80,60,.55)}
  .htitle{color:#d8ffe4;letter-spacing:.12em}
  .hhi{color:#fff}
  .hbox{width:min(660px,92vw);background:#0b0f14;border:1px solid #2b3a2f;border-radius:10px;overflow:hidden;
    box-shadow:0 0 70px rgba(0,0,0,.85),0 0 30px rgba(120,255,160,.12)}
  .hbar{display:flex;gap:7px;align-items:center;padding:9px 12px;background:#141b22;font-size:12px;color:#8a98a6}
  .hbar i{width:10px;height:10px;border-radius:50%;background:#3a4652}
  .hbar span{margin-left:8px}
  .hbox .hpre{padding:16px 18px 18px;min-height:150px}
  .hbig{font-family:Georgia,"Palatino Linotype",serif;font-style:italic;color:#f2ead8;text-align:center;
    font-size:clamp(22px,4vw,44px);line-height:1.35;margin:0;text-shadow:0 0 24px rgba(255,200,140,.35);padding:0 6vw}
  .hdialog{padding:26px 24px;text-align:center;background:#120d18;border-color:#4a3560}
  .hdialog .row{display:flex;gap:12px;justify-content:center;margin:22px 0 12px;flex-wrap:wrap}
  .hdialog button{font:inherit;font-family:Georgia,serif;font-size:16px;color:#f2ead8;background:rgba(255,255,255,.08);
    border:1px solid rgba(255,255,255,.3);border-radius:999px;padding:9px 20px;cursor:pointer}
  .hdialog button:hover{border-color:#ffb43c}
  .hdialog button:focus-visible{outline:2px solid #ffb43c;outline-offset:2px}
  .hsmall{font-size:12px;opacity:.55;font-family:Georgia,serif;color:#d8cfe8;margin:0}
  .hnote{position:absolute;left:0;right:0;bottom:12px;text-align:center;font-size:11px;opacity:.38}
  .hesc{position:absolute;right:14px;bottom:12px;font-size:11px;opacity:.45;font-family:Georgia,serif;color:#fff}
  #hlayer.corrupt .hpre{animation:hjit .5s linear infinite;text-shadow:2px 0 #ff2a4d,-2px 0 #2affff}
  @keyframes hjit{0%{transform:translate(0,0)}25%{transform:translate(-3px,1px) skewX(1.5deg)}50%{transform:translate(2px,-2px)}
    75%{transform:translate(-1px,2px) skewX(-2deg)}100%{transform:translate(0,0)}}
  #hauntNext{font-size:12px;opacity:.6;min-width:5.5em}
  @media(max-width:640px){#hauntNext{display:none}}
  @media(prefers-reduced-motion:reduce){#hlayer.corrupt .hpre{animation:none}}`;
  document.head.appendChild(style);

  const layer = document.createElement('div');
  layer.id = 'hlayer'; layer.hidden = true; layer.setAttribute('role', 'dialog'); layer.setAttribute('aria-label', 'A haunting. Press Escape to leave.');
  document.body.appendChild(layer);

  /* ---------- tiny async toolkit (everything is cancellable, so Esc is instant) ---------- */
  class Cancel extends Error { }
  const pending = new Set();
  const pend = executor => new Promise((res, rej) => {
    const r = () => { pending.delete(r); rej(new Cancel()); };
    pending.add(r); executor(v => { pending.delete(r); res(v); });
  });
  const sleep = ms => pend(done => setTimeout(done, ms / speed));
  const waitFor = async (cond, ms, step = 200) => {
    for (let t = 0; t < ms; t += step) { if (cond()) return true; await sleep(step); }
    return cond();
  };
  const cleanups = [];
  let running = false, on = false, nextAt = 0, lastActivity = performance.now();
  ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(ev =>
    addEventListener(ev, () => { lastActivity = performance.now(); }, { passive: true }));

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  function open(cls) {
    layer.className = cls; layer.innerHTML = ''; layer.hidden = false;
    layer.appendChild(el('div', 'hesc', 'esc — leave'));
    requestAnimationFrame(() => requestAnimationFrame(() => layer.classList.add('in')));
    return layer;
  }
  const note = text => layer.appendChild(el('div', 'hnote', text));
  function panel(title) {           // a little window with a title bar and a <pre> inside
    const box = el('div', 'hbox'), bar = el('div', 'hbar');
    bar.append(el('i'), el('i'), el('i'), el('span', '', title));
    const pre = el('pre', 'hpre'); box.append(bar, pre); layer.appendChild(box); return pre;
  }
  async function line(pre, text, cls, cps = 55) {
    const s = el('span', cls || ''); pre.appendChild(s);
    for (const ch of text) { s.textContent += ch; await sleep(1000 / cps); }
    pre.appendChild(document.createTextNode('\n'));
  }
  async function big(text, cps = 22) {
    const p = el('p', 'hbig'); layer.appendChild(p);
    for (const ch of text) { p.textContent += ch; await sleep(1000 / cps); }
    return p;
  }
  const plat = () => (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || 'Unknown';
  const dots = (k, v) => (k + ' ').padEnd(22, '.') + ' ' + v;

  /* ---------- level: it gets worse the longer you stay ---------- */
  const level = () => launched < 2 ? 1 : launched < 5 ? 2 : 3;
  const LV = { rain: [0.6, 0.78, 0.95], lantern: [1, 0.88, 0.76], build: [5000, 7000, 9000] };

  /* ---------- sound: synthesized in the browser, quiet by design ---------- */
  const audio = (() => {
    let ctx = null, an, master, droneG, rainG, whisperG, wbp, pan, noiseBuf, hbTimer = null, hbInterval = 1100;
    let enabled = false, muted = false, cap = 0.55;
    const t = () => ctx.currentTime;
    const ramp = (p, v, tc = 0.2) => p.setTargetAtTime(v, t(), tc);
    function ensure() {
      if (ctx) { if (ctx.state === 'suspended') ctx.resume().catch(() => { }); return; }
      try {
        const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
        ctx = new AC();
        const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -24; comp.ratio.value = 8;
        master = ctx.createGain(); master.gain.value = 0; master.connect(comp); comp.connect(ctx.destination);
        an = ctx.createAnalyser(); an.fftSize = 2048; comp.connect(an);
        droneG = ctx.createGain(); droneG.gain.value = 0;
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700;
        [[55, 'triangle', 1], [55.8, 'sine', 1], [82.4, 'sine', 0.35], [110, 'triangle', 0.5], [165.7, 'sine', 0.22]].forEach(([f, ty, gv]) => {
          const o = ctx.createOscillator(); o.type = ty; o.frequency.value = f;
          const g = ctx.createGain(); g.gain.value = gv; o.connect(g); g.connect(lp); o.start();
        });
        lp.connect(droneG); droneG.connect(master);
        noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
        const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        const loop = () => { const sr = ctx.createBufferSource(); sr.buffer = noiseBuf; sr.loop = true; sr.start(); return sr; };
        rainG = ctx.createGain(); rainG.gain.value = 0;
        const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 500;
        const rl = ctx.createBiquadFilter(); rl.type = 'lowpass'; rl.frequency.value = 1600;
        loop().connect(hp); hp.connect(rl); rl.connect(rainG); rainG.connect(master);
        whisperG = ctx.createGain(); whisperG.gain.value = 0;
        wbp = ctx.createBiquadFilter(); wbp.type = 'bandpass'; wbp.frequency.value = 2400; wbp.Q.value = 2.5;
        pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
        loop().connect(wbp); wbp.connect(whisperG);
        if (pan) { whisperG.connect(pan); pan.connect(master); } else whisperG.connect(master);
      } catch (e) { ctx = null; }
    }
    function thump(v) {
      const n = t(), o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(75, n); o.frequency.exponentialRampToValueAtTime(38, n + 0.13);
      g.gain.setValueAtTime(0.0001, n); g.gain.exponentialRampToValueAtTime(0.9 * v, n + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, n + 0.22);
      o.connect(g); g.connect(master); o.start(n); o.stop(n + 0.25);
      const o2 = ctx.createOscillator(), g2 = ctx.createGain();   // an upper layer, audible on laptop speakers
      o2.type = 'triangle'; o2.frequency.setValueAtTime(170, n); o2.frequency.exponentialRampToValueAtTime(85, n + 0.1);
      g2.gain.setValueAtTime(0.0001, n); g2.gain.exponentialRampToValueAtTime(0.45 * v, n + 0.012); g2.gain.exponentialRampToValueAtTime(0.0001, n + 0.16);
      o2.connect(g2); g2.connect(master); o2.start(n); o2.stop(n + 0.2);
    }
    function startHeart() {
      stopHeart();
      const beat = () => { if (!ctx || !enabled) return; thump(1); setTimeout(() => ctx && enabled && thump(0.7), 170); hbTimer = setTimeout(beat, hbInterval); };
      beat();
    }
    function stopHeart() { clearTimeout(hbTimer); hbTimer = null; }
    function whisper() {         // breathy, unintelligible: filtered noise in short syllables
      if (!ctx || !enabled) return;
      let at = t(); if (pan) pan.pan.setValueAtTime(Math.random() * 1.6 - 0.8, at);
      for (let i = 0, n = 3 + Math.floor(Math.random() * 4); i < n; i++) {
        const len = 0.07 + Math.random() * 0.14;
        wbp.frequency.setValueAtTime(1500 + Math.random() * 2200, at);
        whisperG.gain.setValueAtTime(0.0001, at); whisperG.gain.linearRampToValueAtTime(0.25 + Math.random() * 0.15, at + 0.03);
        whisperG.gain.linearRampToValueAtTime(0.0001, at + len); at += len + 0.04 + Math.random() * 0.08;
      }
    }
    return {
      ensure,
      state: () => (ctx ? ctx.state : 'none'),
      meter() {                  // what is actually leaving the speakers, in dBFS
        if (!an) return null; const b = new Float32Array(an.fftSize); an.getFloatTimeDomainData(b);
        let sum = 0, pk = 0; for (const v of b) { sum += v * v; pk = Math.max(pk, Math.abs(v)); }
        return { rms: 20 * Math.log10(Math.sqrt(sum / b.length) + 1e-9), peak: 20 * Math.log10(pk + 1e-9) };
      },
      setLevel(l) { cap = [0.55, 0.65, 0.75][l - 1]; if (ctx && enabled && !muted) ramp(master.gain, cap, 0.3); },
      start() { if (!ctx) return; enabled = true; ramp(master.gain, muted ? 0 : cap, 0.6); ramp(rainG.gain, 0.28, 1); ramp(droneG.gain, 0.18, 2); },
      stop() { if (!ctx) return; enabled = false; stopHeart(); ramp(master.gain, 0, 0.25); },
      setMuted(m) { muted = m; if (ctx) ramp(master.gain, (enabled && !m) ? cap : 0, 0.15); },
      dread(p) {                 // p: 0..1, the drone swells, the heart speeds up, whispers creep in
        if (!ctx || !enabled) return;
        ramp(droneG.gain, 0.18 + 0.45 * p, 0.4); ramp(rainG.gain, 0.28 * (1 - p), 0.5);
        hbInterval = 1150 - 720 * p; if (!hbTimer) startHeart();
        if (Math.random() < 0.04 + 0.1 * p) whisper();
      },
      silence(ms) {              // the sudden nothing right before something happens
        if (window.__music && window.__music.silence) window.__music.silence(ms);   // the music cuts out too
        if (!ctx || !enabled) return; stopHeart();
        const n = t(); master.gain.cancelScheduledValues(n); master.gain.setTargetAtTime(0, n, 0.008);
        master.gain.setTargetAtTime(muted ? 0 : cap, n + ms / 1000, 0.25);
      },
      sting() {
        if (!ctx || !enabled) return; const n = t(), o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.setValueAtTime(52, n); o.frequency.exponentialRampToValueAtTime(30, n + 0.5);
        g.gain.setValueAtTime(0.0001, n); g.gain.exponentialRampToValueAtTime(0.7, n + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, n + 0.8);
        o.connect(g); g.connect(master); o.start(n); o.stop(n + 0.85);
      },
      preview() {                // a short sample so you can check your speakers
        if (!ctx || muted) return; const wasOn = enabled; enabled = true; ramp(master.gain, cap, 0.05);
        thump(1); setTimeout(() => thump(0.7), 170); setTimeout(() => thump(1), 900); setTimeout(() => thump(0.7), 1070); setTimeout(whisper, 1500);
        setTimeout(() => { enabled = wasOn; if (!wasOn) ramp(master.gain, 0, 0.3); }, 2600);
      },
      thud() { if (ctx && enabled) thump(0.55); },
      release() { stopHeart(); if (ctx && enabled) { ramp(droneG.gain, 0.18, 1.2); ramp(rainG.gain, 0.28, 1.2); } },
    };
  })();

  /* ---------- the director: tells the 3D scene what to do ---------- */
  function applyBase() {
    const H = hv(); if (!H) return; const l = level() - 1;
    Object.assign(H.dir, { rain: LV.rain[l], lantern: LV.lantern[l], flicker: 0, freeze: false, look: null, lookRate: 0.9 });
  }
  function resetScene() {
    const H = hv(); if (!H) return;
    Object.assign(H.dir, { rain: 0.6, lantern: 1, flicker: 0, freeze: false, look: null, lookRate: 0.9 }); H.farLantern.stop();
  }
  async function buildUp() {     // dread: the rain stops, the lantern gutters, the ghost stills and turns to face you, then silence
    const H = hv(), l = level(), steps = Math.round(LV.build[l - 1] / 100), base = LV.lantern[l - 1];
    audio.setLevel(l); if (window.__music) window.__music.duck(0.08);      // let the dread breathe: the music almost disappears
    if (H) Object.assign(H.dir, { freeze: true, look: 'camera', lookRate: 0.55, rain: 0 });
    for (let i = 1; i <= steps; i++) {
      const p = i / steps;
      if (H) { H.dir.lantern = lerp(base, 0.3, p); H.dir.flicker = p > 0.35 ? (p - 0.35) * 1.2 : 0; }
      audio.dread(p); await sleep(100);
    }
    audio.silence(1000); if (H) { H.dir.lantern = 0.12; H.dir.flicker = 0; } await sleep(1000);
    audio.sting();
  }

  /* ---------- what the ghost says afterwards ---------- */
  const clockTime = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  function clockLine() {
    const h = new Date().getHours(), tm = clockTime();
    if (h < 4) return `It's ${tm}. Why are you still awake?`;
    if (h < 6) return `It's ${tm}. Did you sleep at all?`;
    if (h < 12) return `It's ${tm}. Even ghosts rise early.`;
    if (h < 17) return `It's ${tm}. I only haunt properly after dark.`;
    if (h < 21) return `It's ${tm}. The light is leaving. Good.`;
    return `It's ${tm}. That is when I am strongest.`;
  }
  function summarize(name) {     // [what happened (for the model), a canned line (if no model is running)]
    const f = facts, fled = f.fled ? ' The user pressed Escape to flee.' : '';
    switch (name) {
      case 'system monitor': return f.fled ? ['The user pressed Escape and ran from a fake system monitor.', 'You left before the scan finished.']
        : [`The user watched a fake system monitor scan their ${f.screen} display to the end.`, `Your screen is ${f.screen}. I counted every pixel.`];
      case 'idle': return f.never ? ['The user never stopped moving, so the idle watch found nothing.', 'You never stop moving. I will wait.']
        : f.noResponse ? [`The user sat still for ${f.idle} seconds and did not react when asked if they were still there.${fled}`, `You were still for ${f.idle} seconds. I counted every one.`]
          : [`The user was still for ${f.idle} seconds, then moved ${f.wokeAfter} seconds after being asked if they were still there.${fled}`, `You were gone for ${f.idle} seconds. I stayed.`];
      case 'active window': return f.leftFor != null ? [`The user switched away from this tab for ${f.leftFor} seconds, then came back.`, `You looked away for ${f.leftFor} seconds.`]
        : [`The user obeyed and stayed on this tab.${fled}`, 'Good. Stay.'];
      case 'terminal': return [`A fake terminal reported an unknown process.${fled}`, 'That process is not mine.'];
      case 'file scan': return [`A fake scan listed folders in the user's home directory. Nothing was really read.${fled}`, 'I only counted the doors.'];
      case 'camera moment': return f.granted ? ['The user clicked Allow Camera (it was switched off immediately; nothing was recorded).', 'Thank you for letting me look.']
        : f.choice === 'allow' ? ['The user clicked Allow Camera but the browser refused.', 'Even your browser does not trust me.']
          : f.choice === 'deny' ? ["The user clicked Don't Allow on the camera question.", 'You said no. I heard you.']
            : ['The user ignored the camera question.', 'Silence. I will take that as an answer.'];
      case 'localhost': return [`The page showed that it runs on ${f.host}.${fled}`, 'I live on your machine. Nowhere else.'];
      case 'footsteps': return ['Footsteps rippled across the water toward the ghost, and nothing was there.', 'Did you hear that? Nothing walks on water.'];
      case 'far lantern': return ['A second pale lantern drifted across the water toward the ghost, then vanished.', 'Whose lantern was that?'];
      case 'stare': return [`The ghost stared at something off-screen to the ${f.side}, then turned back to the user.`, `Do not look to the ${f.side}.`];
      case 'clock': return [`It is ${clockTime()} on the user's clock.`, clockLine()];
      default: return ['Dread built up, and then nothing happened.', '...nothing. This time.'];
    }
  }
  function speak(name) {
    const [what, fallback] = summarize(name), note = `[Haunting note: ${what} Local time: ${clockTime()}.]`;
    let tries = 0;
    const go = () => {
      const H = hv(); if (!H || !H.ask || !on || document.body.classList.contains('ofrenda')) return;
      if (H.isBusy() && tries++ < 20) return setTimeout(go, 600);
      H.ask(note, true, fallback);
    };
    setTimeout(go, 1500);
  }

  /* ---------- the events ---------- */
  async function evMonitor() {                       // 1. fake system takeover
    open('hfull');
    if (navigator.userActivation && navigator.userActivation.isActive && layer.requestFullscreen) {
      layer.requestFullscreen().catch(() => { });
      const onFs = () => { if (!document.fullscreenElement) abort(); };
      document.addEventListener('fullscreenchange', onFs);
      cleanups.push(() => { document.removeEventListener('fullscreenchange', onFs); if (document.fullscreenElement) document.exitFullscreen().catch(() => { }); });
    }
    const pre = el('pre', 'hpre'); layer.appendChild(pre);
    facts.screen = `${screen.width}x${screen.height}`;
    note('simulation: only values your browser already shares are shown');
    const c = navigator.connection, ext = screen.isExtended;
    const rows = [
      ['DISPLAY', `${screen.width}x${screen.height} @${window.devicePixelRatio}x`],
      ['MONITORS', ext === undefined ? '?' : (ext ? '2 OR MORE' : '1')],
      ['AUDIO', 'OK'], ['CAMERA', '?'], ['MICROPHONE', '?'],
      ['CPU CORES', navigator.hardwareConcurrency || '?'],
      ['MEMORY', navigator.deviceMemory ? navigator.deviceMemory + '+ GB' : '?'],
      ['NETWORK', navigator.onLine ? (c && c.effectiveType ? c.effectiveType.toUpperCase() : 'CONNECTED') : 'OFFLINE'],
      ['SYSTEM', plat().toUpperCase()], ['LOCAL TIME', new Date().toLocaleTimeString()],
      ['FILES', '1,842'], ['USER', 'FOUND'],
    ];
    await line(pre, 'HAUNT // SYSTEM MONITOR', 'htitle'); await sleep(500);
    await line(pre, 'Scanning local environment...'); await sleep(700);
    for (const [k, v] of rows) { await line(pre, dots(k, v), '', 90); await sleep(110); }
    await sleep(600); await line(pre, '');
    await line(pre, 'WARNING:', 'hwarn'); await line(pre, 'UNEXPECTED PRESENCE DETECTED', 'hwarn'); await sleep(900);
    layer.classList.add('corrupt');
    const orig = pre.textContent, junk = '#%&@$?/\\|<>01', t0 = performance.now();
    const corruptMs = [2200, 3200, 4500][level() - 1];
    while ((performance.now() - t0) * speed < corruptMs) {       // progressively corrupt the interface
      const p = ((performance.now() - t0) * speed) / corruptMs;
      pre.textContent = [...orig].map(ch => (ch !== ' ' && ch !== '\n' && Math.random() < 0.02 + 0.2 * p) ? junk[Math.floor(Math.random() * junk.length)] : ch).join('');
      await sleep(90);
    }
    pre.textContent = ''; layer.classList.remove('corrupt');
    await line(pre, '...', 'hwarn'); await sleep(1300);
  }

  async function evIdle() {                          // 4. real inactivity
    const idleFor = () => (performance.now() - lastActivity) * speed;
    const idle = await waitFor(() => idleFor() > 8000, 30000, 250);
    open('hdim');
    if (!idle) { facts.never = true; await big('You never stop moving.'); await sleep(2200); return; }
    facts.idle = Math.round((performance.now() - lastActivity) / 1000);
    await big('No activity detected.'); await sleep(2200);
    layer.querySelector('.hbig').remove();
    await big('...', 3); await sleep(1500);
    layer.querySelector('.hbig').remove();
    const t1 = performance.now(), p = await big('Are you still there?');
    const woke = await waitFor(() => idleFor() < 1500, 9000, 150);
    p.remove();
    if (woke) { facts.wokeAfter = Math.round((performance.now() - t1) / 1000); await big('There you are.'); }
    else { facts.noResponse = true; await big('You stopped moving.'); await waitFor(() => idleFor() < 1500, 12000, 150); }
    await sleep(2200);
  }

  async function evTab() {                           // 6. active-window awareness (the tab)
    open('hpanel');
    const pre = panel('active window');
    await line(pre, 'ACTIVE WINDOW', 'htitle'); await line(pre, `${document.title}  —  ${location.host}`, 'hhi'); await sleep(900);
    await line(pre, '...'); await sleep(900);
    await line(pre, "I know you're looking at this tab."); await sleep(900);
    await line(pre, "Don't switch.", 'hwarn'); await sleep(2600);
    layer.classList.remove('in');
    const away = () => document.hidden || !document.hasFocus();
    const title = document.title;
    cleanups.push(() => { document.title = title; });
    if (await waitFor(away, 30000)) {
      const awayAt = performance.now();
      const names = ['come back…', 'why did you leave?', title]; let i = 0;
      const iv = setInterval(() => { document.title = names[i++ % 3]; }, 1100);
      cleanups.push(() => clearInterval(iv));
      await waitFor(() => !away(), 180000, 300);
      clearInterval(iv); document.title = title; facts.leftFor = Math.round((performance.now() - awayAt) / 1000);
      open('hdim'); await big('Why did you leave?'); await sleep(3200);
    } else { open('hdim'); await big('Good. Stay.'); await sleep(1800); }
  }

  async function evTerminal() {                      // 7. a (simulated) terminal
    open('hpanel');
    const win = /win/i.test(plat());
    const pre = panel(win ? 'PowerShell — haunt' : 'bash — haunt');
    note('simulated terminal: no commands are run');
    const L = [['> npm run dev'], ['Starting...'], ['✓ Server started'], ['✓ Database connected'], ['✓ Localhost available'], [''],
    ['> scanning...'], ['WARNING: UNKNOWN PROCESS', 'hwarn'], ['pid 6666 (not yours)', 'hwarn'], ['> kill 6666'], ['permission denied', 'hwarn']];
    for (const [t, c] of L) { await line(pre, t, c, 45); await sleep(t.startsWith('>') ? 650 : 260); }
    await sleep(1400); await line(pre, '> _'); await sleep(900);
    layer.querySelector('.hbox').style.transition = 'transform .4s,opacity .4s';
    layer.querySelector('.hbox').style.transform = 'scale(.92)'; layer.querySelector('.hbox').style.opacity = '0'; await sleep(450);
  }

  async function evFiles() {                         // 8. fake filesystem scan
    open('hpanel');
    const p = plat(), root = /win/i.test(p) ? 'C:\\Users\\Developer' : /mac/i.test(p) ? '/Users/developer' : '/home/developer';
    const pre = panel('local environment');
    note('simulated scan: no files were read');
    await line(pre, 'LOCAL ENVIRONMENT', 'htitle'); await sleep(500);
    await line(pre, root, 'hhi'); await sleep(700);
    for (const n of ['├── Projects', '├── Downloads', '├── Documents', '├── Pictures', '└── ...']) { await line(pre, n, '', 30); await sleep(650 + Math.random() * 500); }
    await sleep(1100); await line(pre, ''); await line(pre, 'Something is watching.', 'hwarn'); await sleep(2800);
  }

  async function evCamera() {                        // 9. the permission moment
    open('hpanel');
    const d = el('div', 'hbox hdialog'); layer.appendChild(d);
    const q = el('p', 'hbig'); d.appendChild(q);
    for (const ch of 'I need to know if you’re alone.') { q.textContent += ch; await sleep(45); }
    const row = el('div', 'row'), allow = el('button', '', 'Allow Camera'), deny = el('button', '', 'Don’t Allow');
    row.append(allow, deny); d.append(row);
    d.appendChild(el('p', 'hsmall', 'Nothing is recorded. If you allow, your browser asks first, and the camera is switched off the instant it turns on.'));
    allow.focus({ preventScroll: true });
    const choice = await Promise.race([pend(r => { allow.onclick = () => r('allow'); }), pend(r => { deny.onclick = () => r('deny'); }), sleep(25000).then(() => 'none')]);
    d.remove(); facts.choice = choice;
    let granted = false;
    if (choice === 'allow' && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      granted = await pend(r => navigator.mediaDevices.getUserMedia({ video: true })
        .then(s => { s.getTracks().forEach(t => t.stop()); r(true); }, () => r(false)));   // stopped at once, never used
    }
    facts.granted = granted;
    if (granted) { await big('Thank you.'); await sleep(1700); layer.querySelector('.hbig').remove(); await big('I knew you were alone.'); }
    else if (choice === 'none') { await big('Silence is an answer too.'); }
    else { await big('That’s okay.'); await sleep(1700); layer.querySelector('.hbig').remove(); await big('I already know.'); }
    await sleep(2600);
  }

  async function evLocal() {                         // 10. localhost becomes part of the horror
    open('hpanel');
    const host = location.hostname || 'localhost', port = location.port || '80', url = `${host}:${port}`;
    facts.host = url;
    const pre = panel('haunt engine');
    await line(pre, '[HAUNT HORROR ENGINE]', 'htitle', 40); await sleep(300);
    for (const t of ['Environment: LOCAL', `Host: ${host}`, `Port: ${port}`, 'Process: RUNNING']) { await line(pre, t, '', 50); await sleep(260); }
    await line(pre, ''); await line(pre, `http://${url}`, 'hhi'); await line(pre, 'CONNECTED'); await sleep(900);
    for (let i = 0; i < 3; i++) { await line(pre, url, '', 70); await sleep(380); }
    await sleep(700); await line(pre, '...'); await sleep(900);
    await line(pre, 'Why are you running me locally?', 'hwarn', 30); await sleep(3000);
  }

  async function evSteps() {                         // ripples spread across calm water, as if something walks toward the ghost
    const H = hv(); if (!H) { await sleep(2000); return; }
    const g = H.ghost.pos, a = Math.PI * (1.15 + Math.random() * 0.7), n = 9;
    for (let i = 0; i < n; i++) {
      const d = 10 - i * (8.6 / (n - 1));
      H.ripple(g.x + Math.cos(a) * d, g.z + Math.sin(a) * d); audio.thud(); audio.dread(0.5 + 0.5 * i / n);
      await sleep(1000 - i * 70);
    }
    audio.silence(1300); H.dir.lantern = 0.05; await sleep(1500);
  }
  async function evFar() {                           // a second, paler lantern drifts across the water toward the ghost
    const H = hv(); if (!H) { await sleep(2000); return; }
    const secs = [0, 14, 11][level() - 1] || 11, steps = secs * 10;
    H.farLantern.start({ seconds: secs });
    for (let i = 0; i < steps; i++) { audio.dread(0.35 + 0.65 * i / steps); await sleep(100); }
    H.farLantern.stop(); audio.silence(1500); await sleep(1600);
  }
  async function evStare() {                         // the ghost stares at something off-screen, then snaps back to you
    const H = hv(); if (!H) { await sleep(2000); return; }
    const s = Math.random() < 0.5 ? 1 : -1; facts.side = s > 0 ? 'left' : 'right';
    const gaze = k => Math.PI / 2 + s * k;
    H.dir.lookRate = 0.9;
    for (let i = 0; i < 30; i++) { H.dir.look = gaze(1.1) + (Math.random() - 0.5) * 0.06; audio.dread(0.3 + 0.4 * i / 30); await sleep(100); }
    H.dir.lookRate = 0.5;
    for (let i = 0; i < 30; i++) { H.dir.look = gaze(-1.1) + (Math.random() - 0.5) * 0.06; audio.dread(0.7 + 0.2 * i / 30); await sleep(100); }
    H.dir.lookRate = 3; H.dir.look = 'camera'; audio.silence(1000); audio.sting(); await sleep(1500);
  }
  async function evClock() {                         // a quiet one: the ghost just knows what time it is
    const H = hv(); if (H) H.dir.lantern = Math.min(H.dir.lantern, 0.7);
    facts.time = clockTime(); await sleep(1800);
  }

  // [name, run, first level it may appear on, does it get the dread build-up]
  const EVENTS = [
    ['system monitor', evMonitor, 1, true], ['idle', evIdle, 1, true], ['active window', evTab, 1, true], ['terminal', evTerminal, 1, true],
    ['file scan', evFiles, 1, true], ['camera moment', evCamera, 1, true], ['localhost', evLocal, 1, true],
    ['footsteps', evSteps, 2, true], ['far lantern', evFar, 2, true], ['stare', evStare, 1, true], ['clock', evClock, 1, false],
  ];

  /* ---------- scheduler ---------- */
  async function fire(i, opts = {}) {
    if (running) return; running = true; facts = {}; escPressed = false;
    const ev = EVENTS[i], name = ev ? ev[0] : 'false alarm';
    audio.setLevel(level());
    try {
      if (!ev || (ev[3] && !opts.skipBuild)) await buildUp();
      if (ev) await ev[1]();
      else await sleep(1200);
    } catch (e) { if (!(e instanceof Cancel)) console.error(e); else if (escPressed) facts.fled = true; }
    finally {
      launched++; audio.release(); applyBase(); if (window.__music) window.__music.unduck(); const H = hv(); if (H) H.farLantern.stop();
      if (on && !(document.body.classList.contains('ofrenda'))) speak(name);
      pending.clear();
      cleanups.splice(0).forEach(f => { try { f(); } catch (_) { } });
      layer.classList.remove('in', 'corrupt'); setTimeout(() => { if (!running) layer.hidden = true; }, 380);
      running = false; if (on) nextAt = performance.now() + gap();
    }
  }
  function abort() { [...pending].forEach(f => f()); }
  function launch() {                              // the dice: an empty minute, a false alarm, or a real event
    const r = Math.random();
    if (launched > 0 && r < 0.22) { nextAt = performance.now() + gap(); return; }   // nothing, on purpose
    if (launched > 0 && r < 0.34) return fire(-1);                                   // dread, then nothing
    fire(nextIndex());
  }
  function nextIndex() {          // truly random, never the same twice in a row, and the scarier ones only unlock later
    let i; do { i = Math.floor(Math.random() * EVENTS.length); } while (i === lastIdx || EVENTS[i][2] > level()); return (lastIdx = i);
  }
  const fmt = ms => { const s = Math.ceil(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

  addEventListener('keydown', e => { if (e.key === 'Escape' && running) { escPressed = true; abort(); layer.hidden = true; audio.release(); } });
  btn.addEventListener('click', () => {
    on = !on; btn.setAttribute('aria-pressed', on); btn.textContent = 'Haunting: ' + (on ? 'on' : 'off');
    if (on) { launched = 0; nextAt = performance.now() + gap(); audio.ensure(); audio.setLevel(1); audio.start(); applyBase(); audio.preview(); }
    else { abort(); nextEl.textContent = ''; audio.stop(); resetScene(); }
  });
  let paused = false;
  setInterval(() => {
    if (!on) return;
    const now = performance.now();
    const halloween = !document.body.classList.contains('ofrenda');            // gentle mode is never haunted
    const ready = !$('#intro') && $('#loading') && $('#loading').classList.contains('gone');
    if (!halloween) { if (running) { abort(); layer.hidden = true; } if (!paused) { paused = true; audio.stop(); resetScene(); } nextEl.textContent = 'paused'; nextAt = now + gap(); return; }
    if (paused) { paused = false; audio.start(); applyBase(); }
    if (!ready) { nextAt = now + gap(); return; }
    if (running) { nextEl.textContent = 'haunting…'; return; }
    const left = nextAt - now; nextEl.textContent = DEBUG ? 'next in ' + fmt(Math.max(0, left)) : 'listening…';
    if (left <= 0) launch();
  }, 250);

  // Initialise the audio context on the first user gesture and auto-start
  // the ambient sound as soon as the scene finishes loading.
  let soundStarted = false;
  function tryAutoStartSound() {
    if (soundStarted || on) return;      // haunting mode manages its own audio
    const loading = document.getElementById('loading');
    if (loading && loading.classList.contains('gone')) {
      soundStarted = true;
      audio.ensure();
      audio.start();                     // fade in ambient rain/drone automatically
    }
  }
  // Poll until the scene is ready (the loading overlay disappears)
  const autoStartTimer = setInterval(() => { tryAutoStartSound(); if (soundStarted) clearInterval(autoStartTimer); }, 300);

  // Also ensure the AudioContext exists as soon as the user first interacts
  const initAudioOnce = () => { audio.ensure(); };
  addEventListener('pointerdown', initAudioOnce, { once: true });
  addEventListener('keydown', initAudioOnce, { once: true });

  const sndBtn = $('#hauntSnd');
  if (sndBtn) sndBtn.addEventListener('click', () => {
    const m = sndBtn.getAttribute('aria-pressed') === 'true';   // currently on -> mute
    sndBtn.setAttribute('aria-pressed', String(!m)); sndBtn.textContent = 'Sound: ' + (m ? 'off' : 'on');
    audio.ensure(); audio.setMuted(m); if (!m) audio.preview();
  });

  window.__haunting = { audio, fire, abort, level, launch, audioState: audio.state, names: EVENTS.map(e => e[0]), setSpeed: v => { speed = v; }, isRunning: () => running };
})();
