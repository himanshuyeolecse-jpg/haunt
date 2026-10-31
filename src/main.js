import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const $ = s => document.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const S = 1.5;            // world scale of the ghost model
const BG = 0x030207;

/* ---------------- renderer / scene ---------------- */
const canvas = $('#scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
const scene = new THREE.Scene();
scene.background = new THREE.Color(BG);
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 160);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.5, 0.65, 0.8);
composer.addPass(bloom);
composer.addPass(new OutputPass());

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();

/* ---------------- state ---------------- */
let mode = 'halloween';
const lanternColor = new THREE.Color(1.0, 0.62, 0.22);
const lanternTarget = new THREE.Color(1.0, 0.62, 0.22);
const clock = new THREE.Clock();
const ghost = {
  pos: new THREE.Vector3(0, 0, 0),
  vel: new THREE.Vector3(),
  acc: new THREE.Vector3(),           // smoothed acceleration
  heading: new THREE.Vector2(1, 0.8).normalize(),   // direction of travel on the x/z plane
  yaw: 0,
  boost: false,
  waypoint: null,
  lastInput: -99,
};
const pend = { x: 0, z: 0, vx: 0, vz: 0 };   // lantern tilt (world frame, radians)
const keys = new Set();

/* ---------------- materials ---------------- */
const uniforms = {
  uTime: { value: 0 },
  uPivot: { value: new THREE.Vector3() },
  uLR: { value: new THREE.Matrix3() },
  uWind: { value: new THREE.Vector3() },
  uSpeed: { value: 0 },
  uFlicker: { value: 1 },
};

function makeGhostMaterial(maps) {
  const m = new THREE.MeshStandardMaterial({
    map: maps.color, normalMap: maps.normal, roughnessMap: maps.orm, metalnessMap: maps.orm,
    roughness: 1, metalness: 1, emissive: new THREE.Color(0xffffff), emissiveMap: maps.color, emissiveIntensity: 0.38,
  });
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float lw;
        uniform float uTime; uniform vec3 uPivot; uniform mat3 uLR; uniform vec3 uWind; uniform float uSpeed;
        varying float vLw;`)
      .replace('#include <beginnormal_vertex>', `
        vec3 objectNormal = vec3(normal);
        #ifdef USE_TANGENT
          vec3 objectTangent = vec3(tangent.xyz);
        #endif
        objectNormal = normalize(mix(objectNormal, uLR * objectNormal, lw));`)
      .replace('#include <begin_vertex>', `
        vLw = lw;
        vec3 p = position;
        // cloth: hem and outer folds move in the air; the lantern and head stay firm
        float hem = smoothstep(0.10, -0.42, position.y);
        float rr = length(position.xz);
        float outer = smoothstep(0.06, 0.30, rr);
        float cw = hem * (0.30 + 0.70 * outer) * (1.0 - lw);
        float ang = atan(position.z, position.x);
        vec3 radial = normalize(vec3(position.x, 0.0, position.z) + vec3(1e-4));
        float wave = sin(position.y * 9.0 + uTime * 2.6 + ang * 3.0)
                   + 0.6 * sin(position.y * 17.0 - uTime * 3.7 + ang * 5.0 + 1.3);
        p += radial * wave * 0.010 * cw * (0.7 + uSpeed * 0.9);
        p.y += wave * 0.004 * cw;
        float wl = length(uWind) + 1e-4;
        float down = max(dot(radial, -uWind / wl), 0.0);      // folds on the sheltered side flare out
        p += uWind * cw * (0.55 + 0.45 * cw);
        p += radial * down * wl * 0.9 * cw * cw;
        p.y += down * wl * 0.8 * cw * cw;
        // lantern: swing around the handle
        vec3 d = p - uPivot;
        p = uPivot + mix(d, uLR * d, lw);
        vec3 transformed = p;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vLw; uniform float uFlicker;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
        totalEmissiveRadiance += diffuseColor.rgb * vLw * smoothstep(0.30, 0.85, lum) * 1.5 * uFlicker;`);
  };
  return m;
}

/* water: ripples from rain + the lantern's light breaking up on it */
const waterU = {
  uTime: { value: 0 }, uL1: { value: new THREE.Vector3(0, 1, 0) }, uL1c: { value: lanternColor },
  uL2: { value: new THREE.Vector3(0, 1, 0) }, uClick: { value: new THREE.Vector3(0, 0, -99) },
  uFlicker: uniforms.uFlicker, uBg: { value: new THREE.Color(BG) },
  uPh: { value: [new THREE.Vector3(0, 0, -99), new THREE.Vector3(0, 0, -99), new THREE.Vector3(0, 0, -99), new THREE.Vector3(0, 0, -99)] },
  uL3: { value: new THREE.Vector3(0, 1, -30) }, uL3i: { value: 0 }, uRainAmt: { value: 1 },
};
const water = new THREE.Mesh(
  new THREE.PlaneGeometry(260, 260).rotateX(-Math.PI / 2),
  new THREE.ShaderMaterial({
    uniforms: waterU,
    vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `
      uniform float uTime; uniform vec3 uL1; uniform vec3 uL1c; uniform vec3 uL2; uniform vec3 uClick; uniform float uFlicker; uniform vec3 uBg;
      uniform vec3 uPh[4]; uniform vec3 uL3; uniform float uL3i; uniform float uRainAmt;
      varying vec3 vW;
      float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
      vec2 rings(vec2 p, float scale, float t){
        vec2 g = vec2(0.0);
        vec2 q = p * scale; vec2 id = floor(q); vec2 f = fract(q);
        for(int j=-1;j<=1;j++) for(int i=-1;i<=1;i++){
          vec2 c = id + vec2(float(i), float(j));
          float h1 = hash(c), h2 = hash(c + 17.3);
          vec2 center = vec2(float(i), float(j)) + vec2(h1, h2) - f;
          float period = 1.5 + h1 * 1.9;
          float ph = fract(t / period + h2);
          float r = length(center);
          float w = r - ph * 0.95;
          float env = (1.0 - ph) * (1.0 - ph);
          float E = exp(-w * w * 240.0) * env;
          float ring = sin(w * 36.0) * E;
          float dr = cos(w * 36.0) * E * 36.0 - 480.0 * w * ring;
          vec2 dir = r > 1e-4 ? -center / r : vec2(0.0);
          g += dir * dr;
        }
        return g * scale;
      }
      void main(){
        vec2 p = vW.xz;
        vec2 g = rings(p, 1.35, uTime) * 0.016 * uRainAmt;
        g += vec2(cos(p.x * 1.7 + uTime * 0.9), sin(p.y * 1.3 - uTime * 0.7)) * 0.012;
        g += vec2(sin(p.y * 4.1 + uTime * 1.7), cos(p.x * 3.7 - uTime * 1.3)) * 0.006;
        float age = uTime - uClick.z;
        if(age > 0.0 && age < 2.4){
          float r = length(p - uClick.xy); float w = r - age * 2.2;
          float E = exp(-w * w * 14.0) * (1.0 - age / 2.4);
          vec2 dir = (p - uClick.xy) / max(r, 1e-3);
          g += dir * (cos(w * 7.0) * E * 7.0 - 28.0 * w * sin(w * 7.0) * E) * 0.012;
        }
        float phGlow = 0.0;
        for (int i = 0; i < 4; i++) {
          float pa = uTime - uPh[i].z;
          if (pa > 0.0 && pa < 3.2) {
            vec2 dv = p - uPh[i].xy; float r = length(dv); float w = r - pa;
            float E = exp(-w * w * 36.0) * (1.0 - pa / 3.2);
            g += (dv / max(r, 1e-3)) * (cos(w * 9.0) * E * 9.0 - 72.0 * w * sin(w * 9.0) * E) * 0.011;
            phGlow += E * (0.5 + 0.5 * sin(w * 9.0));
          }
        }
        vec3 N = normalize(vec3(-g.x, 1.0, -g.y));
        vec3 V = normalize(cameraPosition - vW);
        vec3 col = vec3(0.0);
        // lantern light
        vec3 Ld = uL1 - vW; float d = length(Ld); Ld /= d;
        vec3 H = normalize(Ld + V);
        float nh = max(dot(N, H), 0.0);
        float s = pow(nh, 380.0) * 5.5 + pow(nh, 70.0) * 0.45;
        float att = 1.0 / (1.0 + d * d * 0.9);
        col += uL1c * s * att * uFlicker;
        col += uL1c * 0.10 * att * att * (0.35 + 0.65 * max(dot(N, Ld), 0.0)) * uFlicker;
        // the ghost's own pale glow
        vec3 Gd = uL2 - vW; float gd = length(Gd); Gd /= gd;
        vec3 H2 = normalize(Gd + V);
        float nh2 = max(dot(N, H2), 0.0);
        col += vec3(1.0, 0.86, 0.7) * (pow(nh2, 150.0) * 1.1 + pow(nh2, 30.0) * 0.06) / (1.0 + gd * gd * 1.2);
        col += vec3(0.30, 0.42, 0.56) * phGlow * 0.55;
        if (uL3i > 0.001) {
          vec3 L3 = uL3 - vW; float d3 = length(L3); L3 /= d3;
          float nh3 = max(dot(N, normalize(L3 + V)), 0.0);
          col += vec3(0.55, 1.0, 0.85) * (pow(nh3, 300.0) * 4.0 + pow(nh3, 60.0) * 0.25) * uL3i / (1.0 + d3 * d3 * 0.02);
        }
        // faint cold sheen so ripples read near the camera
        float fres = pow(1.0 - max(dot(N, V), 0.0), 5.0);
        col += vec3(0.01, 0.015, 0.03) * fres;
        float dist = length(vW - cameraPosition);
        float fog = exp(-dist * 0.05);
        gl_FragColor = vec4(mix(uBg, col, fog), 1.0);
      }`,
  })
);
scene.add(water);

/* rain: GPU-animated streaks that glint near the lantern */
const RAIN = 3000;
const rainGeo = new THREE.BufferGeometry();
{
  const seed = new Float32Array(RAIN * 2 * 4), end = new Float32Array(RAIN * 2), pos = new Float32Array(RAIN * 2 * 3);
  for (let i = 0; i < RAIN; i++) {
    const a = Math.random(), b = Math.random(), c = Math.random(), d = Math.random();
    for (let e = 0; e < 2; e++) { seed.set([a, b, c, d], (i * 2 + e) * 4); end[i * 2 + e] = e; }
  }
  rainGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  rainGeo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
  rainGeo.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
}
const rainU = { uTime: uniforms.uTime, uCenter: { value: new THREE.Vector3() }, uL: waterU.uL1, uColor: { value: lanternColor }, uRain: { value: 0.6 } };
const rain = new THREE.LineSegments(rainGeo, new THREE.ShaderMaterial({
  uniforms: rainU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  vertexShader: `
    attribute vec4 aSeed; attribute float aEnd;
    uniform float uTime; uniform vec3 uCenter; uniform vec3 uL; uniform float uRain;
    varying float vA;
    void main(){
      if (aSeed.w > uRain) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vA = 0.0; return; }
      float speed = 10.0 + aSeed.w * 5.0;
      float y = mod(aSeed.z * 16.0 - uTime * speed, 16.0);
      float x = uCenter.x + mod(aSeed.x * 30.0 - uCenter.x + 15.0, 30.0) - 15.0;
      float z = uCenter.z + mod(aSeed.y * 26.0 - uCenter.z + 18.0, 26.0) - 18.0;
      vec3 w = vec3(x, y + aEnd * 0.42, z) + vec3(aEnd * 0.05, 0.0, 0.0);
      vec3 dl = w - uL;
      float glint = 1.0 / (1.0 + dot(dl, dl) * 0.55);
      vA = (0.03 + 0.95 * glint) * (aEnd > 0.5 ? 0.35 : 1.0) * smoothstep(0.0, 0.5, y);
      gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
    }`,
  fragmentShader: `uniform vec3 uColor; varying float vA; void main(){ gl_FragColor = vec4(mix(vec3(0.65,0.7,0.85), uColor, 0.6) * vA, vA); }`,
}));
rain.frustumCulled = false;
scene.add(rain);

/* distant bokeh lights on the horizon (and their faint reflection) */
const bokeh = (() => {
  const n = 16, p = new Float32Array(n * 2 * 3), s = new Float32Array(n * 2), a = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const x = (Math.random() * 2 - 1) * 26, z = -26 - Math.random() * 12, y = 0.35 + Math.random() * 0.9;
    p.set([x, y, z], i * 6); p.set([x, -y, z], i * 6 + 3);
    s[i * 2] = s[i * 2 + 1] = 70 + Math.random() * 110; a[i * 2] = 0.9; a[i * 2 + 1] = 0.3;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(s, 1));
  g.setAttribute('aAlpha', new THREE.BufferAttribute(a, 1));
  const pts = new THREE.Points(g, new THREE.ShaderMaterial({
    uniforms: { uTime: uniforms.uTime, uColor: { value: lanternColor } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `attribute float aSize; attribute float aAlpha; uniform float uTime; varying float vA;
      void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * mv;
        gl_PointSize = aSize / -mv.z * 2.6; vA = aAlpha * (0.65 + 0.35 * sin(uTime * 1.3 + position.x * 3.1)); }`,
    fragmentShader: `uniform vec3 uColor; varying float vA; void main(){ float r = length(gl_PointCoord - 0.5);
      float a = smoothstep(0.5, 0.12, r) * 0.7; gl_FragColor = vec4(uColor * a * vA, a * vA); }`,
  }));
  pts.frustumCulled = false; scene.add(pts); return pts;
})();

/* marigold petals for ofrenda mode */
const petals = (() => {
  const n = 160, p = new Float32Array(n * 3), s = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { s.set([Math.random(), Math.random(), Math.random(), Math.random()], i * 4); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  g.setAttribute('aSeed', new THREE.BufferAttribute(s, 4));
  const pts = new THREE.Points(g, new THREE.ShaderMaterial({
    uniforms: { uTime: uniforms.uTime, uCenter: rainU.uCenter },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `attribute vec4 aSeed; uniform float uTime; uniform vec3 uCenter; varying float vA;
      void main(){
        float y = mod(aSeed.z * 6.0 - uTime * (0.25 + aSeed.w * 0.3), 6.0);
        float x = uCenter.x + mod(aSeed.x * 16.0 - uCenter.x + 8.0, 16.0) - 8.0 + sin(uTime * 0.7 + aSeed.w * 20.0) * 0.4;
        float z = uCenter.z + mod(aSeed.y * 14.0 - uCenter.z + 9.0, 14.0) - 9.0 + cos(uTime * 0.5 + aSeed.x * 20.0) * 0.3;
        vec4 mv = viewMatrix * vec4(x, y, z, 1.0); gl_Position = projectionMatrix * mv;
        gl_PointSize = (5.0 + aSeed.w * 7.0) * 60.0 / -mv.z * 0.1; vA = smoothstep(0.0, 0.6, y) * (0.5 + 0.5 * aSeed.w);
      }`,
    fragmentShader: `varying float vA; void main(){ vec2 c = gl_PointCoord - 0.5; float r = length(c * vec2(1.0, 1.5));
      float a = smoothstep(0.5, 0.1, r); gl_FragColor = vec4(vec3(1.0, 0.55, 0.08) * a * vA * 0.9, a * vA); }`,
  }));
  pts.frustumCulled = false; pts.visible = false; scene.add(pts); return pts;
})();

/* ---------------- the director: other scripts (haunting.js) steer these ---------------- */
const dir = { rain: 0.6, rainNow: 0.6, lantern: 1, lanternNow: 1, flicker: 0, flickNow: 1, nextFlick: 0, freeze: false, look: null, lookRate: 0.9 };
let phSlot = 0;
function ripple(x, z) { waterU.uPh.value[phSlot].set(x, z, clock.elapsedTime); phSlot = (phSlot + 1) % 4; }
const farSprite = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(225,255,242,1)'); gr.addColorStop(0.16, 'rgba(150,255,215,.7)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  sp.visible = false; sp.scale.setScalar(1.4); scene.add(sp); return sp;
})();
const far = { on: false, t0: 0, dur: 12, side: 1, closest: 6.5 };
const farLantern = {
  start({ seconds = 13, side = Math.random() < 0.5 ? -1 : 1, closest = 6.5 } = {}) { far.on = true; far.t0 = clock.elapsedTime; far.dur = seconds; far.side = side; far.closest = closest; },
  stop() { far.on = false; },
};
function updateFar(t) {
  if (!far.on) { farSprite.visible = false; waterU.uL3i.value = 0; return; }
  const e = clamp((t - far.t0) / far.dur, 0, 1), k = e * e * (3 - 2 * e);
  farSprite.position.set(ghost.pos.x + lerp(far.side * 9, far.side * 1.8, k) + Math.sin(t * 0.8) * 0.5, 0.72 + Math.sin(t * 1.6) * 0.1, ghost.pos.z + lerp(-28, -far.closest, k));
  const fl = (0.75 + 0.25 * Math.sin(t * 8.7) + 0.1 * Math.sin(t * 21.3)) * clamp((t - far.t0) / 1.5, 0, 1);
  farSprite.visible = true; farSprite.material.opacity = fl; farSprite.scale.setScalar(1.2 + k * 0.7);
  waterU.uL3.value.copy(farSprite.position); waterU.uL3i.value = fl * 1.3;
}
function stepDirector(dt, t) {
  dir.rainNow += (dir.rain - dir.rainNow) * Math.min(1, dt * 1.3);
  dir.lanternNow += (dir.lantern - dir.lanternNow) * Math.min(1, dt * 2.2);
  rainU.uRain.value = dir.rainNow; waterU.uRainAmt.value = clamp(dir.rainNow / 0.6, 0, 1.4);
  if (dir.flicker > 0) {   // at most ~3 changes a second, never a strobe
    if (t > dir.nextFlick) { dir.flickNow = Math.random() < dir.flicker ? 0.12 + Math.random() * 0.3 : 1; dir.nextFlick = t + 0.3 + Math.random() * 0.4; }
  } else dir.flickNow += (1 - dir.flickNow) * Math.min(1, dt * 6);
  updateFar(t);
}

/* lights */
scene.add(new THREE.HemisphereLight(0x2a3a66, 0x120a08, 0.55));
const lanternLight = new THREE.PointLight(0xffa04a, 2.4, 0, 2);
scene.add(lanternLight);
const rim = new THREE.DirectionalLight(0x6f86c8, 0.45);
rim.position.set(-3, 4, -4); scene.add(rim);

/* ---------------- ghost ---------------- */
const root = new THREE.Group();      // position / yaw / lean
scene.add(root);
let ghostMesh = null, meta = null;
const lanternWorld = new THREE.Vector3();
const bodyWorld = new THREE.Vector3();

async function loadGhost() {
  const [metaJ, buf] = await Promise.all([fetch('ghost.json').then(r => r.json()), fetch('ghost.bin').then(r => r.arrayBuffer())]);
  meta = metaJ; const k = meta.verts;
  let o = 0;
  const f32 = n => { const a = new Float32Array(buf, o, n); o += n * 4; return a; };
  const position = f32(k * 3), normal = f32(k * 3), uv = f32(k * 2), lw = f32(k);
  const index = new Uint16Array(buf, o, meta.tris * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('lw', new THREE.BufferAttribute(lw, 1));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  const tl = new THREE.TextureLoader();
  const load = (u, srgb) => new Promise((res, rej) => tl.load(u, t => {
    t.flipY = false; t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy()); t.wrapS = t.wrapT = THREE.RepeatWrapping; res(t);
  }, undefined, rej));
  const [color, orm, normalMap] = await Promise.all([load('tex_color.jpg', true), load('tex_orm.jpg', false), load('tex_normal.jpg', false)]);
  ghostMesh = new THREE.Mesh(geo, makeGhostMaterial({ color, orm, normal: normalMap }));
  ghostMesh.frustumCulled = false;
  ghostMesh.scale.setScalar(S);
  root.add(ghostMesh);
  uniforms.uPivot.value.fromArray(meta.pivot);
}

/* ---------------- input ---------------- */
const KEYDIR = {
  ArrowUp: [0, -1], KeyW: [0, -1], ArrowDown: [0, 1], KeyS: [0, 1],
  ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0],
};
addEventListener('keydown', e => {
  if (e.target === input) return;
  if (KEYDIR[e.code]) { keys.add(e.code); e.preventDefault(); applyKeys(); }
  if (e.key === 'Shift') ghost.boost = true;
});
addEventListener('keyup', e => {
  if (KEYDIR[e.code]) { keys.delete(e.code); applyKeys(); }
  if (e.key === 'Shift') ghost.boost = false;
});
function applyKeys() {
  let x = 0, z = 0;
  keys.forEach(k => { x += KEYDIR[k][0]; z += KEYDIR[k][1]; });
  if (x || z) { ghost.heading.set(x, z).normalize(); ghost.waypoint = null; ghost.lastInput = clock.elapsedTime; }
}

const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit = new THREE.Vector3();
const lanternSphere = new THREE.Sphere(new THREE.Vector3(), 0.3);
const bodySphere = new THREE.Sphere(new THREE.Vector3(), 0.62);
const ptr = { x: 0, y: 0, vx: 0, vy: 0, t: 0, over: false };
function setNdc(e) { ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1); ray.setFromCamera(ndc, camera); }

canvas.addEventListener('pointermove', e => {
  const now = performance.now(), dt = Math.max(0.008, (now - ptr.t) / 1000);
  ptr.vx = lerp(ptr.vx, (e.clientX - ptr.x) / dt, 0.4); ptr.vy = lerp(ptr.vy, (e.clientY - ptr.y) / dt, 0.4);
  ptr.x = e.clientX; ptr.y = e.clientY; ptr.t = now;
  setNdc(e); ptr.over = !!ray.ray.intersectSphere(lanternSphere, hit);
  canvas.style.cursor = ptr.over ? 'grab' : (ray.ray.intersectSphere(bodySphere, hit) ? 'pointer' : 'crosshair');
});
canvas.addEventListener('pointerleave', () => { ptr.over = false; ptr.vx = ptr.vy = 0; });
canvas.addEventListener('pointerdown', e => {
  setNdc(e);
  ptr.x = e.clientX; ptr.y = e.clientY; ptr.t = performance.now();
  if (ray.ray.intersectSphere(lanternSphere, hit)) {
    // a firm push away from the camera, plus whatever sideways motion the pointer has
    pend.vz -= 2.6; pend.vx += clamp(ptr.vx * 0.004, -2, 2);
    ask('The user pushes your lantern and it swings. React in character.', true);
  } else if (ray.ray.intersectSphere(bodySphere, hit)) {
    ask('The user pokes you. React in character.', true);
  } else if (ray.ray.intersectPlane(plane, hit)) {
    ghost.waypoint = hit.clone(); ghost.lastInput = clock.elapsedTime;
    const d = new THREE.Vector2(hit.x - ghost.pos.x, hit.z - ghost.pos.z);
    if (d.lengthSq() > 0.01) ghost.heading.copy(d).normalize();
    waterU.uClick.value.set(hit.x, hit.z, clock.elapsedTime);
  }
});

/* ---------------- simulation ---------------- */
const tmpA = new THREE.Vector3(), q1 = new THREE.Quaternion(), q2 = new THREE.Quaternion(), mat4 = new THREE.Matrix4();
const prevVel = new THREE.Vector3();
let nextWander = 0;

function stepGhost(dt, t) {
  // autopilot: wander from place to place when the user has not steered for a while
  const idle = t - ghost.lastInput;
  if (!ghost.waypoint && idle > 12 && t > nextWander) {
    const a = Math.random() * Math.PI * 2, r = 4 + Math.random() * 6;
    ghost.waypoint = new THREE.Vector3(ghost.pos.x + Math.cos(a) * r, 0, ghost.pos.z + Math.sin(a) * r);
  }
  if (ghost.waypoint) {
    const dx = ghost.waypoint.x - ghost.pos.x, dz = ghost.waypoint.z - ghost.pos.z, d = Math.hypot(dx, dz);
    if (d < 0.7) { ghost.waypoint = null; nextWander = t + 1.5 + Math.random() * 3; }
    else ghost.heading.lerp(new THREE.Vector2(dx / d, dz / d), Math.min(1, dt * 2.2)).normalize();
  }
  // always cruising; holding a key (or Shift) makes it hurry
  const cruise = dir.freeze ? 0 : (ghost.boost ? 2.6 : (keys.size ? 1.9 : 1.15));
  const target = tmpA.set(ghost.heading.x * cruise, 0, ghost.heading.y * cruise);
  prevVel.copy(ghost.vel);
  ghost.vel.lerp(target, Math.min(1, dt * 1.7));
  ghost.pos.addScaledVector(ghost.vel, dt);
  const accNow = tmpA.copy(ghost.vel).sub(prevVel).divideScalar(Math.max(dt, 1e-3));
  ghost.acc.lerp(accNow, Math.min(1, dt * 6));

  // face the direction of travel
  const sp = ghost.vel.length();
  let want = null, rate = 3.2;
  if (dir.look !== null) {
    want = dir.look === 'camera' ? Math.atan2(-(camera.position.z - ghost.pos.z), camera.position.x - ghost.pos.x) : dir.look; rate = dir.lookRate;
  } else if (sp > 0.05) want = Math.atan2(-ghost.vel.z, ghost.vel.x);
  if (want !== null) { let dy = want - ghost.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); ghost.yaw += dy * Math.min(1, dt * rate); }
  const bob = Math.sin(t * 1.25) * 0.07 + Math.sin(t * 2.1 + 1.0) * 0.025;
  root.position.set(ghost.pos.x, 0.92 + bob, ghost.pos.z);
  // lean into the motion and into turns
  const lean = clamp(sp * 0.09, 0, 0.3);
  q1.setFromEuler(new THREE.Euler(0, ghost.yaw, 0));
  const fwd = tmpA.set(Math.cos(ghost.yaw), 0, -Math.sin(ghost.yaw));
  const side = new THREE.Vector3(-fwd.z, 0, fwd.x);
  const turnRoll = clamp(ghost.acc.dot(side) * 0.06, -0.25, 0.25);
  q2.setFromEuler(new THREE.Euler(0, 0, -lean + 0.0));       // pitch around local z (forward lean)
  const q3 = new THREE.Quaternion().setFromEuler(new THREE.Euler(turnRoll, 0, 0));
  root.quaternion.copy(q1).multiply(q2).multiply(q3);

  // wind felt by the robe (local space, model units): trails behind travel, kicked by turns, plus gusts
  const toLocal = (v) => new THREE.Vector3(v.x * Math.cos(ghost.yaw) - v.z * Math.sin(ghost.yaw), 0, v.x * Math.sin(ghost.yaw) + v.z * Math.cos(ghost.yaw));
  const vL = toLocal(ghost.vel), aL = toLocal(ghost.acc);
  const gust = 0.5 + 0.5 * Math.sin(t * 0.6) * Math.sin(t * 0.37 + 1.2);
  uniforms.uWind.value.set(
    -vL.x * 0.052 - aL.x * 0.012 + Math.sin(t * 0.9) * 0.012 * (0.4 + gust),
    0,
    -vL.z * 0.052 - aL.z * 0.012 + Math.cos(t * 0.7) * 0.014 * (0.4 + gust),
  );
  uniforms.uSpeed.value = lerp(uniforms.uSpeed.value, clamp(sp / 2.0, 0, 1.5), Math.min(1, dt * 3));

  // lantern pendulum, world frame. Drag from the air leans it behind the ghost; acceleration swings it.
  const w0 = 3.3, zeta = 0.13;
  const tiltX = -ghost.vel.x * 0.11, tiltZ = -ghost.vel.z * 0.11;
  const gl = Math.sin(t * 0.8) * 0.02;
  pend.vx += (-w0 * w0 * (pend.x - tiltX) - 2 * zeta * w0 * pend.vx - ghost.acc.x * 0.55 + gl) * dt;
  pend.vz += (-w0 * w0 * (pend.z - tiltZ) - 2 * zeta * w0 * pend.vz - ghost.acc.z * 0.55 + Math.cos(t * 0.65) * 0.02) * dt;
  // brushing the lantern with the pointer pushes it
  if (ptr.over) {
    pend.vx += clamp(ptr.vx, -1600, 1600) * 0.0032 * dt;
    pend.vz += clamp(ptr.vy, -1600, 1600) * 0.0032 * dt;
  }
  pend.x = clamp(pend.x + pend.vx * dt, -0.9, 0.9); pend.z = clamp(pend.z + pend.vz * dt, -0.9, 0.9);
  ptr.vx *= 0.9; ptr.vy *= 0.9;

  // world tilt -> model-local tilt -> rotation matrix for the shader
  const cy = Math.cos(ghost.yaw), sy = Math.sin(ghost.yaw);
  const lx = pend.x * cy - pend.z * sy, lz = pend.x * sy + pend.z * cy;
  q1.setFromAxisAngle(new THREE.Vector3(0, 0, 1), lx);
  q2.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -lz);
  q1.multiply(q2);
  mat4.makeRotationFromQuaternion(q1);
  uniforms.uLR.value.setFromMatrix4(mat4);
}

function updateLights(t) {
  if (!ghostMesh) return;
  root.updateMatrixWorld(true);
  const piv = uniforms.uPivot.value;
  const lc = new THREE.Vector3().fromArray(meta.lanternCenter).sub(piv).applyMatrix3(uniforms.uLR.value).add(piv);
  lanternWorld.copy(lc).applyMatrix4(ghostMesh.matrixWorld);
  bodyWorld.set(0, 0, 0).applyMatrix4(ghostMesh.matrixWorld);
  lanternSphere.center.copy(lanternWorld);
  bodySphere.center.copy(bodyWorld);
  const f = 1 + 0.07 * Math.sin(t * 13.1) + 0.05 * Math.sin(t * 23.7 + 1.7) + 0.04 * Math.sin(t * 5.3);
  const fd = f * dir.lanternNow * dir.flickNow;
  uniforms.uFlicker.value = fd;
  lanternLight.position.copy(lanternWorld);
  lanternLight.color.copy(lanternColor);
  lanternLight.intensity = 2.4 * fd;
  waterU.uL1.value.copy(lanternWorld);
  waterU.uL2.value.copy(bodyWorld).add(new THREE.Vector3(0, 0.1, 0));
  rim.target.position.copy(bodyWorld);
}

const camGoal = new THREE.Vector3(), camLook = new THREE.Vector3(), lookNow = new THREE.Vector3();
let camInit = false;
function updateCamera(dt) {
  const aspect = camera.aspect;
  const dist = 6.2 * Math.max(1, 1.25 / aspect);
  camGoal.set(ghost.pos.x + ghost.vel.x * 0.35, 1.25, ghost.pos.z + dist);
  camLook.set(ghost.pos.x + ghost.vel.x * 0.2, 0.95, ghost.pos.z);
  if (!camInit) { camera.position.copy(camGoal); lookNow.copy(camLook); camInit = true; }
  const k = Math.min(1, dt * 2.0);
  camera.position.lerp(camGoal, k); lookNow.lerp(camLook, k);
  camera.lookAt(lookNow);
  water.position.set(camera.position.x, 0, camera.position.z);
  rainU.uCenter.value.set(ghost.pos.x, 0, ghost.pos.z);
  bokeh.position.set(camera.position.x * 0.92, 0, camera.position.z * 0.92);
}

/* speech bubble follows the ghost's head */
const bubble = $('#bubble');
const headV = new THREE.Vector3();
function updateBubble() {
  if (!ghostMesh) return;
  headV.set(0, meta.halfHeight + 0.12, 0).applyMatrix4(ghostMesh.matrixWorld).project(camera);
  const x = clamp((headV.x * 0.5 + 0.5) * innerWidth, 170, innerWidth - 170);
  const y = clamp((-headV.y * 0.5 + 0.5) * innerHeight, 120, innerHeight - 120);
  bubble.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
}

let lastT = 0;
function frame() {
  const dt = Math.min(0.05, clock.getDelta()), t = clock.elapsedTime;
  uniforms.uTime.value = t; waterU.uTime.value = t;
  lanternColor.lerp(lanternTarget, Math.min(1, dt * 2));
  stepDirector(dt, t);
  if (ghostMesh) { stepGhost(dt, t); root.updateMatrixWorld(true); updateLights(t); }
  updateCamera(dt);
  updateBubble();
  composer.render();
  lastT = t;
  requestAnimationFrame(frame);
}

/* ---------------- the ghost talks (local model through Ollama) ---------------- */
const input = $('#in'), sel = $('#models'), status = $('#status');
let busy = false, model = '', log = [];
const FALLBACK = {
  halloween: [
    'I would answer properly, but my mind is asleep in a place called Ollama. Wake it, and I will haunt you better.',
    'Boo. That is all I can manage without a local model.',
    'I can hear you, but I have nothing clever to say. Start Ollama and give me a mind.',
  ],
  ofrenda: [
    'I am here. Start Ollama so I can listen properly, and tell me who you are remembering.',
    'Light a candle for them. When my mind wakes, I will ask about their favorite song.',
  ],
};
const pick = a => a[Math.floor(Math.random() * a.length)];
async function typeOut(text) { bubble.textContent = ''; for (const ch of text) { bubble.textContent += ch; await sleep(22); } }
function hush(ms) { clearTimeout(hush.t); hush.t = setTimeout(() => bubble.classList.remove('show'), ms); }

async function ask(text, _hidden, fallbackLine) {
  if (busy) return;
  busy = true; clearTimeout(hush.t);
  bubble.classList.add('show'); bubble.textContent = '…';
  log.push({ role: 'user', content: text });
  let reply = '';
  try {
    if (!model) throw new Error('no model');
    const r = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, mode, messages: log }) });
    if (!r.ok) throw new Error('bad status');
    const rd = r.body.getReader(), dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { done, value } = await rd.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) {
        if (!l.trim()) continue;
        try { const j = JSON.parse(l); if (j.message) { reply += j.message.content; bubble.textContent = reply; } } catch (_) {}
      }
    }
    if (!reply.trim()) throw new Error('empty');
  } catch (e) { reply = fallbackLine || pick(FALLBACK[mode]); await typeOut(reply); }
  log.push({ role: 'assistant', content: reply });
  busy = false; hush(9000);
}
$('#f').addEventListener('submit', e => { e.preventDefault(); const v = input.value.trim(); if (!v) return; input.value = ''; ask(v); });

$('#modeBtn').addEventListener('click', e => {
  mode = mode === 'halloween' ? 'ofrenda' : 'halloween';
  const of = mode === 'ofrenda';
  document.body.classList.toggle('ofrenda', of);
  e.target.setAttribute('aria-pressed', of);
  lanternTarget.set(of ? 0xff8a10 : 0xff9e38);
  petals.visible = of;
  input.placeholder = of ? 'Tell the ghost who you are remembering…' : 'Whisper to the ghost…';
  log = [];
  ask(of ? 'I want to build an ofrenda. Greet me and ask who I am remembering.' : 'Greet me as a spooky ghost.');
});
sel.addEventListener('change', () => { model = sel.value; });

(async function init() {
  try {
    const j = await (await fetch('/api/models')).json();
    j.models.forEach(m => { const o = document.createElement('option'); o.value = o.textContent = m; sel.appendChild(o); });
    model = j.models[0] || '';
  } catch (_) {}
  if (!model) { sel.style.display = 'none'; status.textContent = 'Ollama not found on localhost:11434. The ghost can only mumble. Run: ollama pull gemma3'; }
  else status.textContent = 'Thinking locally on ' + model + '. Nothing leaves this machine.';
  try { await loadGhost(); } catch (e) { status.textContent = 'Could not load the ghost model: ' + e.message; return; }
  $('#loading').classList.add('gone');
  await sleep(900); ask('Greet me as a spooky ghost.');
})();

window.__haunt = { ghost, pend, uniforms, scene, camera, renderer, dir, ask, isBusy: () => busy, ripple, farLantern };
frame();
