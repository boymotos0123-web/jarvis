// JARVIS FPV Sim — renderização, controles, OSD, áudio, desafios e replay.
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { createWorld, mulberry32 } from './world.js';
import { Drone, PRESETS, MODES, Q, rateDps, clamp } from './sim.js';
import { createMedia } from './media.js';
import { buildScenery } from './scenery.js';
import { createPost } from './post.js';

const $ = (id) => document.getElementById(id);
const D2R = Math.PI / 180;
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;

// ======================================================================
// Configurações persistentes
// ======================================================================
const store = {
  get(k, d) { try { const v = localStorage.getItem('jarvis-fpv.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('jarvis-fpv.' + k, JSON.stringify(v)); } catch { /* armazenamento indisponível */ } },
};

const DEFAULT_MAP = {
  thr: { axis: 1, inv: true }, yaw: { axis: 0, inv: false },
  pitch: { axis: 3, inv: true }, roll: { axis: 2, inv: false },
  arm: { kind: 'button', index: 0 },
};
const RADIO_MAP = {
  roll: { axis: 0, inv: false }, pitch: { axis: 1, inv: false },
  thr: { axis: 2, inv: false }, yaw: { axis: 3, inv: false },
  arm: { kind: 'axis', index: 4 },
};

const settings = Object.assign({
  preset: 'racer', activity: 'free', view: 'fpv', video: 'digital',
  wind: { speed: 2, dir: 60, gust: 0.35 }, timeOfDay: 16.5,
  quality: isTouch ? 'medium' : 'high', volume: 0.55,
  propWash: true, groundEffect: true, battery: true,
  showMap: !(isTouch && innerHeight < 500), showBlackbox: false, deadband: 0.03,
  map: DEFAULT_MAP, per: {}, gimbal: -12, propsInView: false, cine: false, shotRecord: true, hud: true,
}, store.get('settings', {}));
const save = () => store.set('settings', settings);

function perPreset(key = settings.preset) {
  const P = PRESETS[key];
  settings.per[key] = Object.assign({
    mode: P.mode, rates: JSON.parse(JSON.stringify(P.rates)), maxAngle: P.maxAngle, camTilt: P.camTilt, fov: P.fov,
  }, settings.per[key] || {});
  return settings.per[key];
}

// ======================================================================
// Mundo, física e cena
// ======================================================================
const world = createWorld(1337);
const drone = new Drone(world, settings.preset);

const renderer = new THREE.WebGLRenderer({ canvas: $('gl'), antialias: true, powerPreference: 'high-performance', logarithmicDepthBuffer: true });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(80, 1, 0.02, 6000);
const post = createPost(renderer, scene, camera);
let scenery = null;
scene.fog = new THREE.Fog(0xb9c8d4, 300, 1700);

const sky = new Sky();
sky.scale.setScalar(4500);
scene.add(sky);
const su = sky.material.uniforms;
su.turbidity.value = 4.5; su.rayleigh.value = 1.4; su.mieCoefficient.value = 0.004; su.mieDirectionalG.value = 0.8;

const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x4a5a32, 0.6);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 2.6);
sun.castShadow = true;
sun.shadow.camera.left = -45; sun.shadow.camera.right = 45; sun.shadow.camera.top = 45; sun.shadow.camera.bottom = -45;
sun.shadow.camera.near = 1; sun.shadow.camera.far = 500;
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
scene.add(sun, sun.target);
const sunDir = new THREE.Vector3();

const pmrem = new THREE.PMREMGenerator(renderer);
const envScene = new THREE.Scene();
const envSky = new Sky();
envSky.material = sky.material;
envSky.scale.setScalar(4000);
envScene.add(envSky);
let envRT = null;

function setTimeOfDay(h) {
  const elev = Math.sin(((h - 6) / 13) * Math.PI) * 58 - 2;
  const az = 95 + ((h - 6) / 13) * 170;
  sunDir.setFromSphericalCoords(1, (90 - elev) * D2R, az * D2R);
  su.sunPosition.value.copy(sunDir);
  const day = clamp((elev + 2) / 18, 0, 1);
  const warm = 1 - clamp(elev / 25, 0, 1);
  sun.intensity = 0.2 + 2.6 * day;
  sun.color.setRGB(1, 0.86 - 0.22 * warm, 0.72 - 0.38 * warm);
  hemi.intensity = 0.18 + 0.5 * day;
  renderer.toneMappingExposure = 0.42 + 0.18 * (1 - day);
  game.night = 1 - clamp((elev + 4) / 14, 0, 1);
  game.day = day;
  scenery?.setNight(game.night);
  const fog = new THREE.Color().setRGB(0.62 + 0.25 * warm * day, 0.7 - 0.05 * warm, 0.78 - 0.2 * warm).multiplyScalar(0.25 + 0.75 * day);
  scene.fog.color.copy(fog);
  if (envRT) envRT.dispose();
  envRT = pmrem.fromScene(envScene, 0.02);
  scene.environment = envRT.texture;
}

// ---------- texturas procedurais ----------
function canvasTex(w, h, draw, repeat = true) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}
const rnd = mulberry32(99);

const grassTex = canvasTex(256, 256, (g, w, h) => {
  g.fillStyle = '#9a9a9a'; g.fillRect(0, 0, w, h);
  for (let i = 0; i < 9000; i++) {
    const v = 120 + rnd() * 120;
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(rnd() * w, rnd() * h, 1 + rnd() * 1.5, 1 + rnd() * 3);
  }
});
grassTex.repeat.set(380, 380);

// ---------- terreno ----------
function buildTerrain() {
  const { N, CELL, HALF, heights, SEGS } = world;
  const pos = new Float32Array(N * N * 3);
  const col = new Float32Array(N * N * 3);
  const uv = new Float32Array(N * N * 2);
  const c = new THREE.Color();
  for (let iz = 0; iz < N; iz++) {
    for (let ix = 0; ix < N; ix++) {
      const i = iz * N + ix;
      const x = ix * CELL - HALF, z = iz * CELL - HALF, y = heights[i];
      pos.set([x, y, z], i * 3);
      uv.set([ix / SEGS, iz / SEGS], i * 2);
      const n = world.normalAt(x, z);
      const slope = 1 - n.y;
      const r = Math.hypot(x, z);
      const tint = (Math.sin(x * 0.05) * Math.cos(z * 0.043) + Math.sin(x * 0.013 + z * 0.021)) * 0.04;
      c.setRGB(0.25 + tint, 0.38 + tint * 1.4, 0.13);
      if (r < world.FIELD_R + 20) c.setRGB(0.27 + tint * 0.5, 0.42 + tint, 0.15);
      if (y < -8) c.lerp(new THREE.Color(0.2, 0.3, 0.12), 0.6);
      c.lerp(new THREE.Color(0.36, 0.33, 0.28), clamp(slope * 5 - 0.4, 0, 0.9));
      if (y > 45) c.lerp(new THREE.Color(0.5, 0.48, 0.45), clamp((y - 45) / 40, 0, 0.8));
      c.convertSRGBToLinear();
      col.set([c.r, c.g, c.b], i * 3);
    }
  }
  const idx = new Uint32Array(SEGS * SEGS * 6);
  let k = 0;
  for (let iz = 0; iz < SEGS; iz++) {
    for (let ix = 0; ix < SEGS; ix++) {
      const a = iz * N + ix, d = a + 1, b = a + N, cc = b + 1;
      idx.set([a, b, d, b, cc, d], k); k += 6;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, map: grassTex, roughness: 0.96, metalness: 0 }));
  mesh.receiveShadow = true;
  scene.add(mesh);

  // Campo com faixas de grama cortada.
  const stripes = canvasTex(512, 512, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    for (let i = 0; i < 16; i++) { g.fillStyle = i % 2 ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)'; g.fillRect((i * w) / 16, 0, w / 16, h); }
  }, false);
  const field = new THREE.Mesh(new THREE.CircleGeometry(world.FIELD_R - 4, 96), new THREE.MeshStandardMaterial({ map: stripes, transparent: true, depthWrite: false, roughness: 1, polygonOffset: true, polygonOffsetFactor: -2 }));
  field.rotation.x = -Math.PI / 2;
  field.position.y = 0.02;
  field.receiveShadow = true;
  scene.add(field);
}

// ---------- árvores (instanciadas) ----------
function buildTrees() {
  const pines = world.trees.filter((t) => t.kind === 'pine');
  const rounds = world.trees.filter((t) => t.kind === 'round');
  const trunkGeo = new THREE.CylinderGeometry(0.16, 0.28, 1, 6).translate(0, 0.5, 0);
  const coneGeo = new THREE.ConeGeometry(1, 1, 8).translate(0, 0.5, 0);
  const ballGeo = new THREE.IcosahedronGeometry(1, 1);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3626, roughness: 1 });
  const leafMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true });
  const all = world.trees;
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, all.length);
  const cones = new THREE.InstancedMesh(coneGeo, leafMat, pines.length * 2);
  const balls = new THREE.InstancedMesh(ballGeo, leafMat, rounds.length * 2);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), c = new THREE.Color();
  all.forEach((t, i) => { m.compose(p.set(t.x, t.y - 0.3, t.z), q.identity(), s.set(1, t.h * 0.45, 1)); trunks.setMatrixAt(i, m); });
  pines.forEach((t, i) => {
    c.setHSL(0.3 + t.hue * 0.06, 0.45, 0.16 + t.hue * 0.08);
    m.compose(p.set(t.x, t.y + t.h * 0.22, t.z), q.identity(), s.set(t.crown, t.h * 0.55, t.crown)); cones.setMatrixAt(i * 2, m); cones.setColorAt(i * 2, c);
    m.compose(p.set(t.x, t.y + t.h * 0.5, t.z), q.identity(), s.set(t.crown * 0.72, t.h * 0.5, t.crown * 0.72)); cones.setMatrixAt(i * 2 + 1, m); cones.setColorAt(i * 2 + 1, c);
  });
  rounds.forEach((t, i) => {
    c.setHSL(0.22 + t.hue * 0.08, 0.5, 0.22 + t.hue * 0.08);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), t.hue * 6);
    m.compose(p.set(t.x, t.y + t.h * 0.62, t.z), q, s.set(t.crown * 1.15, t.h * 0.3, t.crown * 1.15)); balls.setMatrixAt(i * 2, m); balls.setColorAt(i * 2, c);
    m.compose(p.set(t.x + t.crown * 0.3, t.y + t.h * 0.82, t.z), q, s.set(t.crown * 0.8, t.h * 0.2, t.crown * 0.8)); balls.setMatrixAt(i * 2 + 1, m); balls.setColorAt(i * 2 + 1, c);
  });
  for (const im of [trunks, cones, balls]) { im.castShadow = true; im.receiveShadow = true; scene.add(im); }
}

// ---------- prédios e containers ----------
function buildStructures() {
  const facade = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#8d8a84'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 2000; i++) { g.fillStyle = `rgba(0,0,0,${rnd() * 0.06})`; g.fillRect(rnd() * w, rnd() * h, 3, 3); }
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
      const lit = rnd() < 0.25;
      g.fillStyle = lit ? '#e8d9a8' : '#2c3640';
      g.fillRect(x * 128 + 26, y * 128 + 30, 76, 62);
      g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(x * 128 + 26, y * 128 + 30, 76, 6);
      g.fillStyle = '#6f6c66'; g.fillRect(x * 128 + 20, y * 128 + 92, 88, 6);
    }
  });
  const corrugated = (hex) => canvasTex(128, 128, (g, w, h) => {
    g.fillStyle = hex; g.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 8) { g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(x, 0, 3, h); g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(x + 4, 0, 2, h); }
    for (let i = 0; i < 60; i++) { g.fillStyle = `rgba(80,40,20,${rnd() * 0.2})`; g.fillRect(rnd() * w, rnd() * h, 4 + rnd() * 10, 2 + rnd() * 6); }
  });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x55575a, roughness: 0.9 });
  const cColors = ['#b8501f', '#1f5f8b', '#3f7a3a', '#a33a2c', '#c8a23a'];
  let ci = 0;
  for (const s of world.structures) {
    const h = s.top - s.base;
    let side;
    if (s.kind === 'container') {
      const t = corrugated(cColors[ci++ % cColors.length]);
      t.repeat.set(Math.max(1, s.w / 2.5), 1);
      side = new THREE.MeshStandardMaterial({ map: t, roughness: 0.6, metalness: 0.35 });
    } else {
      const t = facade.clone(); t.needsUpdate = true;
      t.repeat.set(Math.max(1, Math.round(s.w / 7)), Math.max(1, Math.round(h / 7)));
      side = new THREE.MeshStandardMaterial({ map: t, roughness: 0.85 });
      if (s.kind === 'tower') side.color.set(0xb5b0a6);
    }
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(s.w, h, s.d), [side, side, roofMat, roofMat, side, side]);
    mesh.position.set(s.x, (s.base + s.top) / 2, s.z);
    mesh.rotation.y = s.yaw;
    mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh);
    if (s.kind === 'tower') {
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.25, 12, 6), new THREE.MeshStandardMaterial({ color: 0xcc3322 }));
      mast.position.set(s.x + 4, s.top + 6, s.z + 4);
      mast.castShadow = true;
      scene.add(mast);
    }
  }
}

// ---------- portais da pista ----------
const gateViz = [];
function numberTex(text, bg, fg) {
  return canvasTex(256, 128, (g, w, h) => {
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    g.fillStyle = fg; g.font = '800 92px "Saira Condensed", Arial Narrow, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, w / 2, h / 2 + 4);
  }, false);
}
function buildGates() {
  const checker = canvasTex(64, 64, (g) => { for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) { g.fillStyle = (x + y) % 2 ? '#111' : '#f2f2f2'; g.fillRect(x * 16, y * 16, 16, 16); } });
  for (const gt of world.gates) {
    const grp = new THREE.Group();
    grp.position.set(gt.x, gt.ground, gt.z);
    grp.rotation.y = gt.yaw;
    const mat = new THREE.MeshStandardMaterial({ color: 0x1b1f24, emissive: 0xff7a00, emissiveIntensity: 0.25, roughness: 0.5 });
    const t = gt.thick, topY = gt.yb + gt.h, off = gt.w / 2 + t / 2;
    const add = (w, h, d, x, y) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, 0); m.castShadow = true; grp.add(m); };
    add(t, topY + t, t, -off, (topY + t) / 2);
    add(t, topY + t, t, off, (topY + t) / 2);
    add(gt.w + t * 2, t, t, 0, topY + t / 2);
    if (gt.yb > 0.3) add(gt.w + t * 2, t, t, 0, gt.yb - t / 2);
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.45), new THREE.MeshBasicMaterial({ map: numberTex(String(gt.index + 1), '#111418', '#ffb21e'), side: THREE.DoubleSide }));
    plate.position.set(0, topY + t + 0.3, 0);
    grp.add(plate);
    if (gt.index === 0) {
      const ban = new THREE.Mesh(new THREE.PlaneGeometry(gt.w, 0.35), new THREE.MeshStandardMaterial({ map: checker, side: THREE.DoubleSide }));
      checker.repeat.set(8, 1);
      ban.position.set(0, topY - 0.18, 0.08);
      grp.add(ban);
    }
    // Plano luminoso dentro da abertura do próximo portal.
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(gt.w, gt.h), new THREE.MeshBasicMaterial({ color: 0xffb21e, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
    glow.position.set(0, gt.yb + gt.h / 2, 0);
    grp.add(glow);
    scene.add(grp);
    gateViz.push({ mat, glow });
  }
}

// ---------- pontos de pouso ----------
const padViz = [];
function buildPads() {
  for (const p of world.pads) {
    const tex = canvasTex(256, 256, (g, w, h) => {
      g.fillStyle = '#1c2228'; g.beginPath(); g.arc(w / 2, h / 2, w / 2, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#ffb21e'; g.lineWidth = 14; g.beginPath(); g.arc(w / 2, h / 2, w / 2 - 14, 0, Math.PI * 2); g.stroke();
      g.fillStyle = '#f4f4f4'; g.font = '800 150px "Saira Condensed", Arial Narrow, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(p.label, w / 2, h / 2 + 8);
    }, false);
    const m = new THREE.Mesh(new THREE.CircleGeometry(p.r, 48), new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -4 }));
    m.rotation.x = -Math.PI / 2;
    m.position.set(p.x, p.y + 0.012, p.z);
    m.receiveShadow = true;
    scene.add(m);
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(p.r * 0.9, p.r * 0.9, 60, 24, 1, true), new THREE.MeshBasicMaterial({ color: 0x5cc8ff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, fog: false }));
    beam.position.set(p.x, p.y + 30, p.z);
    scene.add(beam);
    padViz.push({ beam });
  }
}

// ---------- área do piloto ----------
function buildPitArea() {
  const metal = new THREE.MeshStandardMaterial({ color: 0x9aa2a8, metalness: 0.7, roughness: 0.4 });
  const canvas = new THREE.MeshStandardMaterial({ color: 0x24313d, roughness: 0.9, side: THREE.DoubleSide });
  const tent = new THREE.Group();
  for (const [x, z] of [[-1.5, -1.5], [1.5, -1.5], [-1.5, 1.5], [1.5, 1.5]]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2.3, 6), metal);
    leg.position.set(x, 1.15, z); tent.add(leg);
  }
  const roof = new THREE.Mesh(new THREE.ConeGeometry(2.3, 0.7, 4, 1, true), canvas);
  roof.position.y = 2.6; roof.rotation.y = Math.PI / 4; tent.add(roof);
  const table = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.05, 0.7), new THREE.MeshStandardMaterial({ color: 0xd8d8d0 }));
  table.position.set(0, 0.75, 0.6); tent.add(table);
  tent.position.set(4.5, 0, 9);
  tent.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
  scene.add(tent);
  const cone = new THREE.ConeGeometry(0.18, 0.5, 12).translate(0, 0.25, 0);
  const coneMat = new THREE.MeshStandardMaterial({ color: 0xff6a1a, roughness: 0.6 });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const m = new THREE.Mesh(cone, coneMat);
    m.position.set(Math.cos(a) * 3.2, 0, Math.sin(a) * 3.2);
    m.castShadow = true;
    scene.add(m);
  }
}

// ======================================================================
// Modelo 3D do drone
// ======================================================================
let model = null;
function buildDroneModel(key) {
  const P = PRESETS[key];
  const a = P.arm, s = Math.max(0.35, P.scale), u = a / 0.08;
  const g = new THREE.Group();
  const carbon = new THREE.MeshStandardMaterial({ color: 0x15181c, roughness: 0.42, metalness: 0.35 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x9aa3ab, metalness: 0.9, roughness: 0.28 });
  const accentHex = { racer: 0xff8a00, cinewhoop: 0x22b3ff, camera: 0x9aa0a6, whoop: 0xff3b6b, mini: 0xd0d3d6, avata: 0x7a8088, longrange: 0x2bd47a }[key];
  const style = P.style;
  const accent = new THREE.MeshStandardMaterial({ color: accentHex, roughness: 0.45, metalness: 0.1 });
  const plastic = new THREE.MeshStandardMaterial({ color: 0x5b6066, roughness: 0.55 });
  const add = (geo, mat, x, y, z, parent = g) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; parent.add(m); return m; };
  const motorPos = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  const spin = [-1, 1, 1, -1];

  if (style === 'camera') {
    // Corpo arredondado, braços dobráveis, sensores frontais e gimbal sob o nariz.
    const k = a / 0.125;
    const shell = new THREE.MeshStandardMaterial({ color: key === 'mini' ? 0xc9ccd0 : 0x3d4146, roughness: 0.42, metalness: 0.15 });
    plastic.color.copy(shell.color);
    const body = add(new THREE.CapsuleGeometry(0.03 * k, 0.1 * k, 6, 16).rotateX(Math.PI / 2), shell, 0, 0, 0);
    body.scale.set(1.35, 0.85, 1);
    add(new THREE.BoxGeometry(0.05 * k, 0.012 * k, 0.09 * k), new THREE.MeshStandardMaterial({ color: 0x1d2024, roughness: 0.3, metalness: 0.4 }), 0, 0.024 * k, 0.012 * k);
    const sensor = new THREE.MeshStandardMaterial({ color: 0x05070a, roughness: 0.1, metalness: 0.8 });
    for (const sx of [-1, 1]) add(new THREE.CircleGeometry(0.006 * k, 16), sensor, sx * 0.016 * k, 0.008 * k, -0.081 * k);
    for (const [sx, sz] of motorPos) {
      const arm = add(new THREE.BoxGeometry(0.016 * k, 0.011 * k, a * Math.SQRT2 * 0.95), plastic, sx * a / 2, 0.006 * k, sz * a / 2);
      arm.rotation.y = Math.atan2(sx, sz);
      add(new THREE.BoxGeometry(0.005 * k, 0.045 * k, 0.01 * k), plastic, sx * a * (sz < 0 ? 0.9 : 0.4), -0.026 * k, sz * a * (sz < 0 ? 0.9 : 0.4));
    }
    const gimbal = new THREE.Group();
    gimbal.position.set(0, -0.02 * k, -0.105 * k);
    add(new THREE.BoxGeometry(0.03 * s, 0.025 * s, 0.02 * s), new THREE.MeshStandardMaterial({ color: 0x202326 }), 0, 0, 0, gimbal);
    add(new THREE.CylinderGeometry(0.008 * s, 0.008 * s, 0.006 * s, 16).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x0a2440, metalness: 0.9, roughness: 0.1 }), 0, 0, -0.012 * s, gimbal);
    g.add(gimbal);
    g.userData.gimbal = gimbal;
  } else {
    if (key === 'avata') {
      const shell = new THREE.MeshStandardMaterial({ color: 0x4a4f56, roughness: 0.45 });
      const body = add(new THREE.CapsuleGeometry(0.028, 0.06, 6, 14).rotateX(Math.PI / 2), shell, 0, 0.02, 0);
      body.scale.set(1.25, 0.9, 1);
    }
    if (key === 'longrange') {
      add(new THREE.CylinderGeometry(0.014 * u, 0.014 * u, 0.006 * u, 16), new THREE.MeshStandardMaterial({ color: 0x1a1d22 }), 0, 0.062 * u, 0.045 * u);
      add(new THREE.CylinderGeometry(0.0012 * u, 0.0012 * u, 0.09 * u, 5), new THREE.MeshStandardMaterial({ color: 0x111111 }), 0, 0.09 * u, 0.07 * u);
    }
    const len = a * 2 * Math.SQRT2 + 0.03 * u;
    for (const rot of [Math.PI / 4, -Math.PI / 4]) {
      const arm = add(new THREE.BoxGeometry(0.013 * u + 0.002, 0.005 * u + 0.001, len), carbon, 0, 0, 0);
      arm.rotation.y = rot;
    }
    add(new THREE.BoxGeometry(0.04 * u, 0.003 * u + 0.001, 0.09 * u), carbon, 0, 0.026 * u, 0);
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) add(new THREE.CylinderGeometry(0.002 * u, 0.002 * u, 0.024 * u, 6), metal, x * 0.016 * u, 0.013 * u, z * 0.035 * u);
    const bat = add(new THREE.BoxGeometry(0.034 * u, 0.026 * u, 0.072 * u), accent, 0, 0.042 * u, 0.006 * u);
    bat.material = bat.material.clone();
    const cam = new THREE.Group();
    cam.position.set(0, 0.012 * u, -0.042 * u);
    cam.rotation.x = perPreset(key).camTilt * D2R;
    add(new THREE.BoxGeometry(0.019 * u, 0.019 * u, 0.018 * u), new THREE.MeshStandardMaterial({ color: 0x24272b, roughness: 0.6 }), 0, 0, 0, cam);
    add(new THREE.CylinderGeometry(0.007 * u, 0.008 * u, 0.012 * u, 16).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x050608, metalness: 0.9, roughness: 0.15 }), 0, 0, -0.012 * u, cam);
    g.add(cam);
    g.userData.cam = cam;
    const ant = add(new THREE.CylinderGeometry(0.0015 * u, 0.0015 * u, 0.05 * u, 5), new THREE.MeshStandardMaterial({ color: 0x111111 }), 0, 0.045 * u, 0.06 * u);
    ant.rotation.x = 0.7;
  }

  const props = [];
  const ledMat = new THREE.MeshBasicMaterial({ color: 0xff2030 });
  const ledMatF = new THREE.MeshBasicMaterial({ color: 0x30ff70 });
  motorPos.forEach(([sx, sz], i) => {
    const mx = sx * a, mz = sz * a;
    const mr = style === 'camera' ? 0.012 * s : 0.012 * u + 0.002;
    add(new THREE.CylinderGeometry(mr, mr, mr * 1.4, 16), metal, mx, 0.008 * s, mz).material = new THREE.MeshStandardMaterial({ color: key === 'racer' ? 0x2a2d31 : 0x9aa3ab, metalness: 0.85, roughness: 0.3 });
    const rotor = new THREE.Group();
    rotor.position.set(mx, 0.02 * s, mz);
    const bladeMat = new THREE.MeshStandardMaterial({ color: style === 'camera' ? 0x2a2d31 : accentHex, roughness: 0.5, transparent: true });
    const blades = new THREE.Group();
    const nb = style === 'camera' ? 2 : key === 'whoop' ? 4 : 3;
    for (let b = 0; b < nb; b++) {
      const bl = new THREE.Mesh(new THREE.BoxGeometry(P.propR * 0.96, 0.0016 * u + 0.0005, P.propR * 0.22).translate(P.propR * 0.48, 0, 0), bladeMat);
      bl.rotation.y = (b / nb) * Math.PI * 2;
      bl.rotation.x = 0.12 * spin[i];
      bl.castShadow = true;
      blades.add(bl);
    }
    rotor.add(blades);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(P.propR, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: style === 'camera' ? 0x777777 : accentHex, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
    rotor.add(disc);
    g.add(rotor);
    if (style === 'duct') {
      const duct = add(new THREE.CylinderGeometry(P.propR * 1.1, P.propR * 1.1, 0.03 * u, 28, 1, true), new THREE.MeshStandardMaterial({ color: key === 'whoop' ? 0x1a1a1f : key === 'avata' ? 0x6b7078 : 0x15181c, roughness: 0.5, side: THREE.DoubleSide }), mx, 0.016 * s, mz);
      duct.castShadow = true;
    }
    props.push({ blades, disc, bladeMat, spin: spin[i], angle: rnd() * 6 });
    if (sz > 0) add(new THREE.SphereGeometry(0.004 * s + 0.002, 8, 6), ledMat, mx * 0.6, -0.004 * s, mz * 0.9);
    else add(new THREE.SphereGeometry(0.004 * s + 0.002, 8, 6), ledMatF, mx * 0.6, -0.004 * s, mz * 0.9);
  });
  g.userData.props = props;
  return g;
}

function setModel(key) {
  if (model) scene.remove(model);
  model = buildDroneModel(key);
  scene.add(model);
}

// ======================================================================
// Áudio (motores, vento, impactos)
// ======================================================================
const sound = {
  ctx: null,
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.ctx = ctx;
      this.master = ctx.createGain(); this.master.gain.value = 0;
      this.master.connect(ctx.destination);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2600; lp.connect(this.master);
      this.motors = [0, 1, 2, 3].map(() => {
        const o = ctx.createOscillator(); o.type = 'sawtooth';
        const o2 = ctx.createOscillator(); o2.type = 'triangle';
        const gn = ctx.createGain(); gn.gain.value = 0;
        o.connect(gn); o2.connect(gn); gn.connect(lp);
        o.start(); o2.start();
        return { o, o2, gn };
      });
      const len = ctx.sampleRate * 2;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;
      const n = ctx.createBufferSource(); n.buffer = buf; n.loop = true;
      this.windF = ctx.createBiquadFilter(); this.windF.type = 'bandpass'; this.windF.frequency.value = 600; this.windF.Q.value = 0.6;
      this.windG = ctx.createGain(); this.windG.gain.value = 0;
      n.connect(this.windF); this.windF.connect(this.windG); this.windG.connect(this.master);
      n.start();
    } catch (e) { console.warn('Áudio indisponível', e); this.ctx = null; }
  },
  update(tel, dist, active) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const vol = active ? settings.volume : 0;
    this.master.gain.setTargetAtTime(vol, t, 0.08);
    const att = 1 / (1 + dist / 6);
    const rpmMax = PRESETS[settings.preset].rpm;
    tel.motors.forEach((m, i) => {
      const f = Math.max(20, (m * rpmMax) / 60) * (0.98 + i * 0.012);
      const mm = this.motors[i];
      mm.o.frequency.setTargetAtTime(f, t, 0.02);
      mm.o2.frequency.setTargetAtTime(f * 2.01, t, 0.02);
      mm.gn.gain.setTargetAtTime((m > 0.01 ? 0.015 + 0.07 * m * m : 0) * att, t, 0.03);
    });
    const sp = tel.speed;
    this.windG.gain.setTargetAtTime(clamp(sp / 40, 0, 0.5) * (0.4 + att) + tel.vrs * 0.08, t, 0.1);
    this.windF.frequency.setTargetAtTime(400 + sp * 25, t, 0.1);
  },
  burst(gain = 0.6, dur = 0.35, freq = 900) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const n = ctx.createBufferSource(); n.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = freq;
    const gn = ctx.createGain(); gn.gain.setValueAtTime(gain * settings.volume, t); gn.gain.exponentialRampToValueAtTime(0.001, t + dur);
    n.connect(f); f.connect(gn); gn.connect(ctx.destination); n.start(t); n.stop(t + dur);
  },
  beep(freq = 1320, dur = 0.09, gain = 0.25) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = freq;
    const gn = ctx.createGain(); gn.gain.setValueAtTime(gain * settings.volume, t); gn.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(gn); gn.connect(ctx.destination); o.start(t); o.stop(t + dur);
  },
};

// ======================================================================
// Entrada: teclado, gamepad / rádio USB, toque
// ======================================================================
const input = { thr: 0, roll: 0, pitch: 0, yaw: 0, source: 'teclado' };
const keys = new Set();
const kb = { thr: 0, roll: 0, pitch: 0, yaw: 0 };
const pad = { index: -1, name: '', prevButtons: [], armPrev: null, active: false, axes: [] };
const touch = { thr: 0, yaw: 0, roll: 0, pitch: 0, active: false, l: null, r: null };

function axisVal(gp, m) {
  if (!m || m.axis === undefined || m.axis < 0 || m.axis >= gp.axes.length) return 0;
  const v = gp.axes[m.axis] || 0;
  return m.inv ? -v : v;
}
const dz = (v, d) => (Math.abs(v) < d ? 0 : (v - Math.sign(v) * d) / (1 - d));

function pollGamepad() {
  const list = navigator.getGamepads ? navigator.getGamepads() : [];
  let gp = null;
  for (const g of list) if (g && g.connected && g.axes.length >= 4) { gp = g; break; }
  if (!gp) { pad.active = false; pad.index = -1; return null; }
  if (pad.index !== gp.index) { pad.index = gp.index; pad.name = gp.id; pad.prevButtons = gp.buttons.map((b) => b.pressed); pad.armPrev = null; updatePadStatus(); }
  pad.axes = gp.axes.slice();
  const moved = gp.axes.some((v, i) => Math.abs(v - (pad.rest?.[i] ?? v)) > 0.25) || gp.buttons.some((b) => b.pressed);
  if (!pad.rest) pad.rest = gp.axes.slice();
  if (moved) pad.active = true;
  // Botões (padrão Xbox/PS): A armar · B reset · X modo · Y câmera · Start menu · Select replay
  const pressed = gp.buttons.map((b) => b.pressed);
  const edge = (i) => pressed[i] && !pad.prevButtons[i];
  const m = settings.map.arm || {};
  if (m.kind === 'button' && edge(m.index)) action('arm');
  if (m.kind === 'axis' && gp.axes.length > m.index) {
    const on = gp.axes[m.index] > 0.4;
    if (pad.armPrev !== null && on !== pad.armPrev) action(on ? 'arm-on' : 'arm-off');
    pad.armPrev = on;
  }
  if (edge(1)) action('reset');
  if (edge(2)) action('mode');
  if (edge(3)) action('cam');
  if (edge(9)) action('menu');
  if (edge(8)) action('replay');
  if (edge(4)) action('photo');
  if (edge(5)) action('record');
  pad.gimbal = (gp.buttons[7]?.value || 0) - (gp.buttons[6]?.value || 0);
  pad.prevButtons = pressed;
  return gp;
}

function updateInput(dt) {
  const gp = pollGamepad();
  const posMode = drone.cfg.mode === 'pos';
  // Teclado
  const k = (c) => keys.has(c);
  const target = (pos, neg) => (k(pos) ? 1 : 0) - (k(neg) ? 1 : 0);
  const approach = (cur, tgt, rate) => cur + clamp(tgt - cur, -rate * dt, rate * dt);
  const rRate = 3.2, back = 6;
  const rt = target('ArrowRight', 'ArrowLeft') || target('KeyL', 'KeyJ');
  const pt = target('ArrowUp', 'ArrowDown') || target('KeyI', 'KeyK');
  const yt = target('KeyD', 'KeyA');
  kb.roll = approach(kb.roll, rt, rt ? rRate : back);
  kb.pitch = approach(kb.pitch, pt, pt ? rRate : back);
  kb.yaw = approach(kb.yaw, yt, yt ? rRate : back);
  const tt = target('KeyW', 'KeyS');
  if (posMode) kb.thr = approach(kb.thr, 0.5 + tt * 0.5, 2.5);
  else kb.thr = clamp(kb.thr + tt * (tt > 0 ? 0.55 : 0.8) * dt * (k('ShiftLeft') ? 2 : 1), 0, 1);
  const kbActive = rt || pt || yt || tt;
  // Gimbal: Q/E ou gatilhos do gamepad.
  const gIn = target('KeyE', 'KeyQ') || pad.gimbal || 0;
  if (gIn) { gimbalPitch = clamp(gimbalPitch + gIn * 45 * dt, -90, 20); settings.gimbal = gimbalPitch; }

  if (gp && pad.active && !kbActive) {
    const m = settings.map, d = settings.deadband;
    input.thr = clamp((axisVal(gp, m.thr) + 1) / 2, 0, 1);
    input.yaw = dz(axisVal(gp, m.yaw), d);
    input.pitch = dz(axisVal(gp, m.pitch), d);
    input.roll = dz(axisVal(gp, m.roll), d);
    input.source = 'controle';
    kb.thr = input.thr;
  } else if (touch.active && !kbActive) {
    Object.assign(input, { thr: touch.thr, yaw: touch.yaw, pitch: touch.pitch, roll: touch.roll, source: 'toque' });
    kb.thr = input.thr;
  } else {
    Object.assign(input, { thr: kb.thr, yaw: kb.yaw, pitch: kb.pitch, roll: kb.roll, source: 'teclado' });
    if (kbActive) { pad.active = false; touch.active = false; }
  }
}

addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && document.activeElement) document.activeElement.blur();
  if (e.code !== 'Escape' && e.target.closest && e.target.closest('select, input')) return;
  sound.init();
  if (!keys.has(e.code)) {
    const map = {
      Space: 'arm', KeyR: 'reset', KeyC: 'cam', KeyM: 'mode', Escape: 'menu', KeyT: 'replay', KeyB: 'blackbox', KeyN: 'map', KeyV: 'video', KeyF: 'fullscreen',
      KeyP: 'photo', KeyG: 'record', KeyO: 'gallery', KeyZ: 'cine', KeyH: 'hud', Digit1: 'shot-dronie', Digit2: 'shot-orbit', Digit3: 'shot-rocket',
    };
    if (map[e.code]) { e.preventDefault(); action(map[e.code]); }
  }
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
  keys.add(e.code);
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
addEventListener('gamepadconnected', () => { pad.rest = null; updatePadStatus(); });
addEventListener('gamepaddisconnected', () => { pad.active = false; updatePadStatus(); });

function updatePadStatus() {
  const el = $('padStatus');
  const list = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
  if (list.length) {
    el.textContent = 'Controle conectado: ' + list[0].id.slice(0, 60);
    el.classList.add('on');
  } else {
    el.textContent = isTouch ? 'Toque: stick esquerdo = acelerador/yaw, direito = pitch/roll.' : 'Nenhum controle USB detectado. Conecte e mexa um stick (gamepad ou rádio em modo joystick).';
    el.classList.remove('on');
  }
}

// Sticks virtuais
function setupTouch() {
  const bind = (el, side) => {
    const knob = el.querySelector('.knob');
    const place = (x, y) => { knob.style.left = `${(x + 1) * 50}%`; knob.style.top = `${(1 - y) * 50}%`; };
    const fromEvent = (e) => {
      const r = el.getBoundingClientRect();
      return { x: clamp(((e.clientX - r.left) / r.width) * 2 - 1, -1, 1), y: clamp(1 - ((e.clientY - r.top) / r.height) * 2, -1, 1) };
    };
    const apply = (v) => {
      touch.active = true;
      if (side === 'l') { touch.yaw = dz(v.x, 0.06); touch.thr = (v.y + 1) / 2; } else { touch.roll = dz(v.x, 0.04); touch.pitch = dz(v.y, 0.04); }
      place(v.x, v.y);
    };
    el.addEventListener('pointerdown', (e) => { sound.init(); el.setPointerCapture(e.pointerId); touch[side] = e.pointerId; apply(fromEvent(e)); });
    el.addEventListener('pointermove', (e) => { if (touch[side] === e.pointerId) apply(fromEvent(e)); });
    const end = (e) => {
      if (touch[side] !== e.pointerId) return;
      touch[side] = null;
      if (side === 'l') {
        touch.yaw = 0;
        if (drone.cfg.mode === 'pos') touch.thr = 0.5;
        place(0, touch.thr * 2 - 1);
      } else { touch.roll = 0; touch.pitch = 0; place(0, 0); }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    place(0, side === 'l' ? -1 : 0);
  };
  bind($('stickL'), 'l');
  bind($('stickR'), 'r');
}
function syncTouchThrottle() {
  touch.thr = drone.cfg.mode === 'pos' ? 0.5 : 0;
  const k = $('stickL').querySelector('.knob');
  k.style.left = '50%'; k.style.top = `${(1 - (touch.thr * 2 - 1)) * 50}%`;
}

// ======================================================================
// Estado do jogo: atividades, crash, replay
// ======================================================================
const ACTIVITIES = {
  free: { name: 'Voo livre', desc: 'Campo aberto, prédios, containers e bosques. Explore sem cronômetro.' },
  race: { name: 'Corrida', desc: '12 portais, 3 voltas. Melhor volta salva por aeronave.' },
  land: { name: 'Pouso de precisão', desc: 'Pouse nos alvos: chão, telhado de container e topo da torre.' },
};
const game = {
  state: 'boot', // boot | start | fly | menu | crash | replay | results
  view: settings.view,
  paused: false,
  race: null, land: null,
  prevPos: null,
  toastT: 0,
  crashInfo: null,
  flash: 0,
};
const VIEWS = ['fpv', 'chase', 'los', 'orbit'];
const VIEW_NAMES = { fpv: 'FPV', chase: 'Perseguição', los: 'Visada (piloto)', orbit: 'Órbita livre' };

function toast(msg, secs = 1.6) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  game.toastT = secs;
}

function applySettingsToDrone() {
  const pp = perPreset();
  drone.cfg.mode = pp.mode;
  drone.cfg.rates = JSON.parse(JSON.stringify(pp.rates));
  drone.cfg.maxAngle = pp.maxAngle;
  drone.cfg.wind = { ...settings.wind };
  drone.cfg.propWash = settings.propWash;
  drone.cfg.groundEffect = settings.groundEffect;
  drone.cfg.battery = settings.battery;
  drone.cfg.cine = settings.cine;
  if (model && model.userData.cam) model.userData.cam.rotation.x = pp.camTilt * D2R;
}

function selectPreset(key) {
  settings.preset = key;
  drone.setPreset(key);
  applySettingsToDrone();
  setModel(key);
  resetFlight();
  save();
}

function spawnPoint() {
  return { x: world.spawn.x, z: world.spawn.z, yaw: 0 };
}

function resetFlight() {
  if (shot.kind) stopShot();
  drone.reset(spawnPoint());
  applySettingsToDrone();
  game.prevPos = { ...drone.s.pos };
  recorder.clear();
  blackbox.clear();
  game.crashInfo = null;
  $('crash').hidden = true;
  $('results').hidden = true;
  syncTouchThrottle();
  kb.thr = drone.cfg.mode === 'pos' ? 0.5 : 0;
  if (settings.activity === 'race') game.race = { next: 0, lap: 0, laps: 3, started: false, lapStart: 0, times: [], t: 0, split: null };
  else game.race = null;
  if (settings.activity === 'land') game.land = { target: 1, hold: 0, score: 0, done: 0, t0: 0, last: null };
  else game.land = null;
  if (game.state === 'crash' || game.state === 'results' || game.state === 'replay') game.state = 'fly';
  if (game.state === 'menu' && game.resumeTo !== 'start') game.resumeTo = 'fly';
  $('replayBar').hidden = true;
  updateGateViz();
}

function action(a) {
  sound.init();
  const st = game.state;
  if (a === 'menu') {
    if (st === 'gallery') return closeGallery();
    if (!$('cinePanel').hidden) { $('cinePanel').hidden = true; return; }
    if (st === 'menu') return closeMenu();
    if (st === 'replay') return exitReplay();
    if (st === 'fly' || st === 'crash' || st === 'results') return openMenu();
    return;
  }
  if (a === 'gallery') return st === 'gallery' ? closeGallery() : openGallery();
  if (a === 'gal-close') return closeGalleryView();
  if (st === 'gallery') return;
  if (a === 'photo') return takePhoto();
  if (a === 'record') return toggleRecord();
  if (a === 'hud') { settings.hud = !settings.hud; applyHud(); save(); return; }
  if (a === 'cine-panel') { const cp = $('cinePanel'); cp.hidden = !cp.hidden; if (!cp.hidden) syncCinePanel(); return; }
  if (a === 'fullscreen') { document.documentElement.requestFullscreen?.().catch(() => {}); return; }
  if (a === 'blackbox') { settings.showBlackbox = !settings.showBlackbox; $('blackbox').hidden = !settings.showBlackbox; save(); return; }
  if (a === 'map') { settings.showMap = !settings.showMap; $('minimap').hidden = !settings.showMap; save(); return; }
  if (a === 'video') { settings.video = settings.video === 'digital' ? 'analog' : 'digital'; toast(settings.video === 'digital' ? 'Vídeo digital HD' : 'Vídeo analógico'); save(); return; }
  if (a === 'cam') {
    game.view = VIEWS[(VIEWS.indexOf(game.view) + 1) % VIEWS.length];
    settings.view = game.view; save();
    toast(VIEW_NAMES[game.view]);
    return;
  }
  if (st === 'replay') {
    if (a === 'replay') return exitReplay();
    if (a === 'arm') { replay.playing = !replay.playing; return; }
    return;
  }
  if (a === 'reset') { if (st === 'menu') closeMenu(); return resetFlight(); }
  if (a === 'replay') { if (recorder.count > 30) startReplay(); return; }
  if (st !== 'fly') return;
  if (a === 'arm' || a === 'arm-on' || a === 'arm-off') {
    if (drone.s.armed && a !== 'arm-on') { drone.disarm(); toast('Desarmado'); return; }
    if (!drone.s.armed && a !== 'arm-off') {
      const why = drone.arm(input.thr);
      toast(why || 'Armado', why ? 2.2 : 1);
      if (!why) sound.beep(880, 0.12);
    }
    return;
  }
  if (a === 'cine') {
    settings.cine = !settings.cine;
    drone.cfg.cine = settings.cine;
    save();
    syncCinePanel();
    toast(settings.cine ? (drone.cfg.mode === 'pos' ? 'Modo Cine' : 'Modo Cine (ative o GPS com M)') : 'Modo Cine desligado', 1.8);
    return;
  }
  if (a.startsWith('shot-')) return startShot(a.slice(5));
  if (a === 'mode') {
    if (shot.kind) stopShot();
    const order = ['acro', 'angle', 'pos'];
    const pp = perPreset();
    pp.mode = order[(order.indexOf(drone.cfg.mode) + 1) % order.length];
    drone.cfg.mode = pp.mode;
    drone.resetController();
    if (pp.mode === 'pos') { kb.thr = 0.5; touch.thr = Math.max(touch.thr, 0.5); }
    syncTouchThrottleIfIdle();
    toast('Modo ' + MODES[pp.mode]);
    save();
  }
}
function syncTouchThrottleIfIdle() { if (touch.l === null) syncTouchThrottle(); }

drone.on('crash', (e) => {
  if (shot.kind) stopShot();
  game.crashInfo = { ...e, speed: Math.hypot(drone.s.vel.x, drone.s.vel.y, drone.s.vel.z), time: drone.s.armTime };
  game.flash = 1;
  sound.burst(0.9, 0.5, 1400);
  setTimeout(() => {
    if (game.state !== 'fly' || !drone.s.crashed) return;
    game.state = 'crash';
    const kinds = { ground: 'chão', building: 'prédio', container: 'container', tree: 'árvore', gate: 'portal', water: 'água', pole: 'poste' };
    $('crashStats').innerHTML = [
      ['Impacto', `${e.impact.toFixed(1)} m/s`], ['Contra', kinds[e.kind] || e.kind],
      ['Tempo de voo', fmt(game.crashInfo.time)], ['Bateria usada', `${drone.bat.mah.toFixed(0)} mAh`],
    ].map(([k, v]) => `<span>${k}</span><span>${v}</span>`).join('');
    $('crash').hidden = false;
  }, 900);
});
drone.on('bump', (e) => { if (e.impact > 2) sound.burst(Math.min(0.5, e.impact / 12), 0.15, e.prop ? 3000 : 700); });

function fmt(t) {
  if (!isFinite(t)) return '--:--.--';
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

// ---------- foto, vídeo e galeria ----------
const media = createMedia({
  canvas: renderer.domElement, renderer, audio: () => (sound.ctx ? sound : null), onChange: () => updateMediaUI(),
  setPixelRatio: (v) => { renderer.setPixelRatio(v); post.resize(); },
});

function flashShot() {
  const f = $('flash');
  f.classList.remove('go');
  void f.offsetWidth;
  f.classList.add('go');
}
async function takePhoto() {
  if (!['fly', 'crash', 'results', 'replay'].includes(game.state)) return;
  sound.beep(2600, 0.04, 0.12);
  flashShot();
  const it = await media.photo(2);
  if (it) toast(`Foto na galeria · ${it.w}×${it.h}`, 1.4);
}
function toggleRecord() {
  if (media.recording) { media.stopRecording(() => toast('Vídeo salvo na galeria', 1.6)); return; }
  if (!media.startRecording()) toast('Este navegador não grava vídeo', 2);
}
const fmtDur = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
function updateMediaUI() {
  $('rec').hidden = !media.recording;
  document.querySelectorAll('[data-act="record"]').forEach((b) => b.classList.toggle('on', media.recording));
  $('galCount').textContent = media.items.length ? String(media.items.length) : '';
  if (game.state === 'gallery') renderGallery();
}
function applyHud() {
  const on = settings.hud;
  $('osd').hidden = !on;
  $('topbar').classList.toggle('faded', !on);
  $('minimap').hidden = !on || !settings.showMap;
  $('blackbox').hidden = !on || !settings.showBlackbox;
}

function openGallery() {
  if (game.state === 'start' || game.state === 'boot') return;
  game.resumeTo = game.state === 'menu' ? game.resumeTo : game.state;
  if (shot.kind) stopShot();
  if (media.recording) media.stopRecording();
  game.state = 'gallery';
  ['menu', 'crash', 'results', 'cinePanel'].forEach((id) => { $(id).hidden = true; });
  $('gallery').hidden = false;
  closeGalleryView();
  renderGallery();
}
function closeGallery() {
  closeGalleryView();
  $('gallery').hidden = true;
  document.activeElement?.blur();
  const r = game.resumeTo;
  game.state = r === 'crash' || r === 'results' || r === 'replay' ? r : 'fly';
  if (r === 'crash') $('crash').hidden = false;
  if (r === 'results') $('results').hidden = false;
}
let galUrl = null, galItem = null;
function closeGalleryView() {
  $('galView').hidden = true;
  $('gallery').classList.remove('viewing');
  $('galMedia').innerHTML = '';
  if (galUrl) { URL.revokeObjectURL(galUrl); galUrl = null; }
  galItem = null;
}
function renderGallery() {
  const g = $('galGrid');
  if (!media.items.length) {
    g.innerHTML = '<p class="note">Nada aqui ainda. Durante o voo aperte <kbd>P</kbd> para foto, <kbd>G</kbd> para gravar, ou use um voo automático no painel Cine.</p>';
    return;
  }
  g.innerHTML = media.items.map((it) => `<figure class="shot">
    <button class="thumb" data-view="${it.id}" aria-label="Abrir">${it.thumb ? `<img src="${it.thumb}" alt="">` : ''}<span class="badge">${it.kind === 'video' ? '▶ ' + fmtDur(it.duration || 0) : 'FOTO'}</span></button>
    <figcaption><span>${new Date(it.created).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })} · ${(it.size / 1048576).toFixed(1)} MB</span>
    <span class="btns"><button class="ghost mini" data-save="${it.id}">Salvar</button><button class="ghost mini" data-del="${it.id}">Apagar</button></span></figcaption></figure>`).join('');
}
async function saveItem(it) {
  const r = await media.save(it);
  toast(r === 'saved' ? 'Arquivo enviado para o aparelho' : 'Salvamento cancelado', 1.6);
}
$('galGrid').addEventListener('click', (e) => {
  const v = e.target.closest('[data-view]'), sv = e.target.closest('[data-save]'), dl = e.target.closest('[data-del]');
  if (v) {
    const it = media.items.find((x) => x.id === v.dataset.view);
    if (!it) return;
    closeGalleryView();
    galItem = it;
    galUrl = URL.createObjectURL(it.blob);
    $('galMedia').innerHTML = it.kind === 'video' ? `<video src="${galUrl}" controls autoplay playsinline></video>` : `<img src="${galUrl}" alt="Foto do voo">`;
    $('galView').hidden = false;
    $('gallery').classList.add('viewing');
  } else if (sv) {
    const it = media.items.find((x) => x.id === sv.dataset.save);
    if (it) saveItem(it);
  } else if (dl) {
    // Dois toques para apagar (sem diálogo de confirmação).
    if (dl.dataset.armed) media.remove(dl.dataset.del);
    else { dl.dataset.armed = '1'; dl.textContent = 'Confirmar?'; setTimeout(() => { if (dl.isConnected) { delete dl.dataset.armed; dl.textContent = 'Apagar'; } }, 2500); }
  }
});
$('galSave').addEventListener('click', () => { if (galItem) saveItem(galItem); });

// ---------- modo Cine e voos automáticos (QuickShots) ----------
const shot = { kind: null };
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const droneHeading = () => { const f = Q.rot(drone.s.q, { x: 0, y: 0, z: -1 }); return Math.atan2(-f.x, -f.z); };
const SHOT_NAMES = { dronie: 'Dronie', orbit: 'Órbita', rocket: 'Foguete' };

function startShot(kind) {
  if (shot.kind) return stopShot('Voo automático cancelado');
  const s = drone.s;
  if (!s.armed || s.onGround || drone.tel.agl < 1.5) return toast('Decole e suba alguns metros primeiro', 2);
  if (drone.cfg.mode !== 'pos') {
    perPreset().mode = 'pos';
    drone.cfg.mode = 'pos';
    drone.resetController();
    kb.thr = 0.5;
    syncTouchThrottleIfIdle();
  }
  const h = droneHeading();
  const fx = -Math.sin(h), fz = -Math.cos(h);
  Object.assign(shot, { kind, t: 0, h, fx, fz, start: { ...s.pos }, recBy: false, R: 10 });
  shot.center = { x: s.pos.x + fx * shot.R, z: s.pos.z + fz * shot.R };
  shot.dur = kind === 'dronie' ? 9 : kind === 'orbit' ? (2 * Math.PI * shot.R) / 3 + 1 : 7;
  if (settings.shotRecord && !media.recording) shot.recBy = media.startRecording();
  $('cinePanel').hidden = true;
  toast(`${SHOT_NAMES[kind]} — mexa um stick para cancelar`, 2);
}
function stopShot(msg) {
  drone.auto = null;
  if (shot.recBy && media.recording) media.stopRecording(() => toast('Voo automático salvo na galeria', 1.8));
  else if (msg) toast(msg, 1.4);
  shot.kind = null;
}
function updateShot(dt) {
  if (!shot.kind) return;
  const s = drone.s;
  const moved = Math.max(Math.abs(input.roll), Math.abs(input.pitch), Math.abs(input.yaw)) > 0.35 || Math.abs(input.thr - 0.5) > 0.35;
  if (!s.armed || drone.cfg.mode !== 'pos' || moved) return stopShot('Voo automático cancelado');
  shot.t += dt;
  const ease = clamp(Math.min(shot.t / 1.5, (shot.dur - shot.t) / 1.5), 0, 1);
  const P = PRESETS[settings.preset];
  const hdg = droneHeading();
  let vel, yawRate;
  if (shot.kind === 'dronie') {
    vel = { x: -shot.fx * 3.2 * ease, y: 1.6 * ease, z: -shot.fz * 3.2 * ease };
    yawRate = 3 * wrap(shot.h - hdg);
    if (P.gimbal) {
      const dist = Math.hypot(s.pos.x - shot.start.x, s.pos.z - shot.start.z) + 2;
      gimbalPitch = clamp((-Math.atan2(s.pos.y - shot.start.y + 1.2, dist) * 180) / Math.PI, -90, 0);
    }
  } else if (shot.kind === 'orbit') {
    const rx = s.pos.x - shot.center.x, rz = s.pos.z - shot.center.z;
    const r = Math.hypot(rx, rz) || 1;
    const sp = 3 * ease;
    vel = { x: (-rz / r) * sp + (rx / r) * (shot.R - r) * 0.8, y: 0, z: (rx / r) * sp + (rz / r) * (shot.R - r) * 0.8 };
    const face = Math.atan2(rx, rz);
    yawRate = 4 * wrap(face - hdg) - sp / shot.R;
    if (P.gimbal) gimbalPitch = clamp((-Math.atan2(s.pos.y - shot.start.y + 1.5, shot.R) * 180) / Math.PI, -90, 0);
  } else {
    vel = { x: 0, y: 3 * ease, z: 0 };
    yawRate = 0.25 * ease;
    if (P.gimbal) gimbalPitch = -90;
  }
  drone.auto = { vel, yawRate };
  if (shot.t >= shot.dur) stopShot('Voo automático concluído');
}

function syncCinePanel() {
  $('cp-cine').checked = settings.cine;
  $('cp-rec').checked = settings.shotRecord;
  $('cp-gimbal').value = String(Math.round(gimbalPitch));
  $('cp-gimbal-o').textContent = `${Math.round(gimbalPitch)}°`;
}
$('cinePanel').addEventListener('input', (e) => {
  const id = e.target.id;
  if (id === 'cp-cine') { settings.cine = e.target.checked; drone.cfg.cine = settings.cine; if (settings.cine && drone.cfg.mode !== 'pos') toast('Cine funciona no modo GPS (M)', 2); }
  if (id === 'cp-rec') settings.shotRecord = e.target.checked;
  if (id === 'cp-gimbal') { gimbalPitch = Number(e.target.value); settings.gimbal = gimbalPitch; $('cp-gimbal-o').textContent = `${gimbalPitch}°`; }
  save();
});

// ---------- corrida ----------
function bestLapKey() { return 'best.' + settings.preset; }
function updateRace() {
  const r = game.race;
  if (!r) return;
  if (r.started) r.t = drone.s.time - r.lapStart;
  const g = world.gates[r.next];
  if (!world.gateCrossed(g, game.prevPos, drone.s.pos)) return;
  sound.beep(r.next === 0 ? 1760 : 1320, 0.08);
  if (r.next === 0) {
    if (!r.started) { r.started = true; r.lapStart = drone.s.time; r.raceStart = drone.s.time; r.lap = 1; toast('Volta 1/3', 1); }
    else {
      const lt = drone.s.time - r.lapStart;
      r.times.push(lt);
      const best = store.get(bestLapKey(), null);
      r.split = best ? lt - best : null;
      if (!best || lt < best) { store.set(bestLapKey(), lt); toast('Melhor volta! ' + fmt(lt), 2); } else toast(`Volta ${r.lap}: ${fmt(lt)}`, 1.6);
      r.lapStart = drone.s.time;
      r.lap++;
      if (r.lap > r.laps) return finishRace();
    }
  }
  r.next = (r.next + 1) % world.gates.length;
  updateGateViz();
}
function finishRace() {
  const r = game.race;
  const total = r.times.reduce((a, b) => a + b, 0);
  const totKey = 'bestTotal.' + settings.preset;
  const prev = store.get(totKey, null);
  if (!prev || total < prev) store.set(totKey, total);
  game.state = 'results';
  drone.disarm();
  $('resTitle').textContent = 'Corrida concluída';
  $('resStats').innerHTML = [
    ...r.times.map((t, i) => [`Volta ${i + 1}`, fmt(t)]),
    ['Total', fmt(total)], ['Recorde total', fmt(Math.min(total, prev ?? Infinity))],
    ['Melhor volta (recorde)', fmt(store.get(bestLapKey(), NaN))],
  ].map(([k, v]) => `<span>${k}</span><span>${v}</span>`).join('');
  $('results').hidden = false;
}
function updateGateViz() {
  gateViz.forEach((gv, i) => {
    const next = game.race && i === game.race.next;
    const after = game.race && i === (game.race.next + 1) % world.gates.length;
    gv.mat.emissive.setHex(next ? 0xffb21e : after ? 0x3fa9ff : 0xff5a00);
    gv.mat.emissiveIntensity = next ? 1.6 : after ? 0.8 : game.race ? 0.12 : 0.35;
    gv.glow.material.opacity = next ? 0.12 : 0;
  });
  padViz.forEach((pv, i) => { pv.beam.material.opacity = game.land && i === game.land.target ? 0.16 : 0; });
}

// ---------- pouso ----------
function updateLanding(dt) {
  const L = game.land;
  if (!L) return;
  const p = world.pads[L.target];
  const s = drone.s;
  const d = Math.hypot(s.pos.x - p.x, s.pos.z - p.z);
  const sp = Math.hypot(s.vel.x, s.vel.y, s.vel.z);
  if (s.onGround && d < p.r && Math.abs(s.pos.y - p.y) < 0.4 && sp < 0.4) {
    L.hold += dt;
    if (L.hold > 1.2) {
      const pts = Math.round(Math.max(10, 100 - (d / p.r) * 60));
      L.score += pts; L.done++;
      L.last = { pts, d };
      toast(`Alvo ${p.label}: +${pts} (erro ${(d * 100).toFixed(0)} cm)`, 2.2);
      sound.beep(1568, 0.15);
      L.target = L.target % (world.pads.length - 1) + 1;
      L.hold = 0;
      if (L.done === world.pads.length - 1) {
        const k = 'bestLand.' + settings.preset;
        const prev = store.get(k, 0);
        if (L.score > prev) store.set(k, L.score);
        game.state = 'results';
        drone.disarm();
        $('resTitle').textContent = 'Missão de pouso concluída';
        $('resStats').innerHTML = [['Pontos', `${L.score} / ${(world.pads.length - 1) * 100}`], ['Recorde', String(Math.max(L.score, prev))], ['Tempo', fmt(drone.s.armTime)]]
          .map(([k2, v]) => `<span>${k2}</span><span>${v}</span>`).join('');
        $('results').hidden = false;
      }
      updateGateViz();
    }
  } else L.hold = 0;
}

// ---------- gravador / replay ----------
const recorder = {
  cap: 60 * 40, stride: 11, buf: null, count: 0, head: 0, acc: 0,
  clear() { this.buf = new Float32Array(this.cap * this.stride); this.count = 0; this.head = 0; this.acc = 0; },
  push(dt) {
    this.acc += dt;
    if (this.acc < 1 / 60) return;
    this.acc = 0;
    const s = drone.s, o = this.head * this.stride, om = drone.d.omegaMax;
    this.buf.set([s.pos.x, s.pos.y, s.pos.z, s.q.x, s.q.y, s.q.z, s.q.w, s.motor[0] / om, s.motor[1] / om, s.motor[2] / om, s.motor[3] / om], o);
    this.head = (this.head + 1) % this.cap;
    this.count = Math.min(this.cap, this.count + 1);
  },
  frame(i) {
    const idx = (this.head - this.count + i + this.cap) % this.cap, o = idx * this.stride, b = this.buf;
    return { pos: { x: b[o], y: b[o + 1], z: b[o + 2] }, q: { x: b[o + 3], y: b[o + 4], z: b[o + 5], w: b[o + 6] }, m: [b[o + 7], b[o + 8], b[o + 9], b[o + 10]] };
  },
};
recorder.clear();
const replay = { t: 0, playing: true, prevState: 'fly', prevView: 'chase' };
function startReplay() {
  replay.prevState = game.state === 'replay' ? replay.prevState : game.state;
  replay.prevView = game.view;
  game.state = 'replay';
  replay.t = 0; replay.playing = true;
  $('cinePanel').hidden = true;
  if (game.view === 'fpv') game.view = 'chase';
  $('crash').hidden = true; $('results').hidden = true; $('menu').hidden = true;
  $('replayBar').hidden = false;
}
function exitReplay() {
  if (replay.rec) { replay.rec = false; media.stopRecording(() => toast('Replay salvo na galeria', 1.8)); }
  game.view = replay.prevView;
  $('replayBar').hidden = true;
  game.state = replay.prevState === 'menu' ? 'fly' : replay.prevState;
  if (game.state === 'crash') $('crash').hidden = false;
  if (game.state === 'results') $('results').hidden = false;
}

// ---------- blackbox ----------
const blackbox = {
  n: 400, buf: null, i: 0, acc: 0,
  clear() { this.buf = new Float32Array(this.n * 10); this.i = 0; },
  push(dt) {
    this.acc += dt;
    if (this.acc < 0.01) return;
    this.acc = 0;
    const t = drone.tel, s = drone.s, om = drone.d.omegaMax;
    this.buf.set([t.sp.x, t.gyro.x, t.sp.y, t.gyro.y, t.sp.z, t.gyro.z, s.motor[0] / om, s.motor[1] / om, s.motor[2] / om, s.motor[3] / om], (this.i % this.n) * 10);
    this.i++;
  },
};
blackbox.clear();

// ======================================================================
// Câmeras
// ======================================================================
const tmpQ = new THREE.Quaternion(), tmpQ2 = new THREE.Quaternion(), tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3();
const chase = { pos: new THREE.Vector3(0, 2, 6), init: false };
const orbit = { yaw: 0.6, pitch: 0.35, dist: 3, drag: null };
let gimbalPitch = settings.gimbal;
let gimbalQ = new THREE.Quaternion();

function setFovH(hdeg) {
  const v = 2 * Math.atan(Math.tan((hdeg * D2R) / 2) / camera.aspect) / D2R;
  camera.fov = clamp(v, 20, 115);
}

function updateCamera(dt, pose) {
  const P = PRESETS[settings.preset];
  const pp = perPreset();
  const sz = Math.max(0.45, P.scale);
  const p = pose.pos, q = pose.q;
  const dq = new THREE.Quaternion(q.x, q.y, q.z, q.w);
  const fwd = tmpV.set(0, 0, -1).applyQuaternion(dq);
  const heading = Math.atan2(-fwd.x, -fwd.z);

  if (game.view === 'fpv' && game.state !== 'start') {
    if (P.gimbal) {
      camera.quaternion.copy(gimbalQ);
      camera.position.set(p.x, p.y - 0.03 * sz, p.z).add(tmpV2.set(0, 0, -P.arm * 0.9).applyQuaternion(dq));
    } else {
      camera.quaternion.copy(dq).multiply(tmpQ.setFromAxisAngle(new THREE.Vector3(1, 0, 0), pp.camTilt * D2R));
      camera.position.set(p.x, p.y, p.z).add(tmpV2.set(0, 0.012 * sz, -P.arm * 0.55).applyQuaternion(dq));
    }
    setFovH(pp.fov);
  } else if (game.view === 'chase' || game.state === 'start') {
    const back = 1.7 * sz + 0.4, upOff = 0.55 * sz + 0.15;
    const want = new THREE.Vector3(p.x + Math.sin(heading) * back, p.y + upOff, p.z + Math.cos(heading) * back);
    if (!chase.init) { chase.pos.copy(want); chase.init = true; }
    chase.pos.lerp(want, 1 - Math.exp(-dt * 5));
    const gy = world.heightAt(chase.pos.x, chase.pos.z) + 0.25;
    if (chase.pos.y < gy) chase.pos.y = gy;
    camera.position.copy(chase.pos);
    camera.lookAt(p.x - Math.sin(heading) * 0.6 * sz, p.y + 0.1 * sz, p.z - Math.cos(heading) * 0.6 * sz);
    setFovH(95);
  } else if (game.view === 'los') {
    const pl = world.pilot;
    camera.position.set(pl.x, pl.y, pl.z);
    camera.lookAt(p.x, p.y, p.z);
    const dist = Math.hypot(p.x - pl.x, p.y - pl.y, p.z - pl.z);
    camera.fov = clamp((2 * Math.atan((2.2 * sz) / Math.max(dist, 0.1))) / D2R, 6, 60);
  } else {
    const d = orbit.dist * sz;
    camera.position.set(p.x + Math.sin(orbit.yaw) * Math.cos(orbit.pitch) * d, p.y + Math.sin(orbit.pitch) * d, p.z + Math.cos(orbit.yaw) * Math.cos(orbit.pitch) * d);
    const gy = world.heightAt(camera.position.x, camera.position.z) + 0.15;
    if (camera.position.y < gy) camera.position.y = gy;
    camera.lookAt(p.x, p.y, p.z);
    setFovH(90);
  }
  if (game.view !== 'chase') chase.init = false;
  camera.updateProjectionMatrix();
}

const glc = $('gl');
glc.addEventListener('pointerdown', (e) => { sound.init(); if (game.view === 'orbit') { orbit.drag = { x: e.clientX, y: e.clientY, id: e.pointerId }; glc.setPointerCapture(e.pointerId); } });
glc.addEventListener('pointermove', (e) => {
  if (!orbit.drag || orbit.drag.id !== e.pointerId) return;
  orbit.yaw -= (e.clientX - orbit.drag.x) * 0.008;
  orbit.pitch = clamp(orbit.pitch + (e.clientY - orbit.drag.y) * 0.006, -0.3, 1.45);
  orbit.drag.x = e.clientX; orbit.drag.y = e.clientY;
});
glc.addEventListener('pointerup', () => { orbit.drag = null; });
glc.addEventListener('wheel', (e) => {
  if (game.view === 'fpv' && PRESETS[settings.preset].gimbal) { gimbalPitch = clamp(gimbalPitch - Math.sign(e.deltaY) * 3, -90, 20); settings.gimbal = gimbalPitch; }
}, { passive: true });
glc.addEventListener('wheel', (e) => { if (game.view === 'orbit') orbit.dist = clamp(orbit.dist * (e.deltaY > 0 ? 1.1 : 0.9), 0.8, 40); }, { passive: true });

// ======================================================================
// OSD (estilo Betaflight) + minimapa + blackbox
// ======================================================================
const osd = $('osd'), og = osd.getContext('2d');
const mm = $('minimap'), mg = mm.getContext('2d');
const bb = $('blackbox'), bg = bb.getContext('2d');
const noiseC = $('noise'), ng = noiseC.getContext('2d');
const noiseImg = ng.createImageData(160, 90);
let osdW = 0, osdH = 0, dpr = 1;

function resize() {
  const q = settings.quality;
  const pr = q === 'low' ? Math.min(devicePixelRatio, 1) * 0.75 : q === 'medium' ? Math.min(devicePixelRatio, 1.25) : q === 'high' ? Math.min(devicePixelRatio, 1.5) : Math.min(devicePixelRatio, 2);
  renderer.setPixelRatio(pr);
  renderer.setSize(innerWidth, innerHeight, false);
  post.enabled = q !== 'low';
  post.setSamples(q === 'medium' ? 0 : 4);
  post.resize();
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  dpr = Math.min(devicePixelRatio, 2);
  osd.width = Math.round(innerWidth * dpr); osd.height = Math.round(innerHeight * dpr);
  osdW = innerWidth; osdH = innerHeight;
  const sm = q === 'low' ? 0 : q === 'medium' ? 1024 : q === 'high' ? 2048 : 4096;
  renderer.shadowMap.enabled = sm > 0;
  sun.castShadow = sm > 0;
  if (sm && sun.shadow.mapSize.x !== sm) { sun.shadow.mapSize.set(sm, sm); sun.shadow.map?.dispose(); sun.shadow.map = null; }
  scene.traverse((o) => { if (o.material) [].concat(o.material).forEach((m) => { m.needsUpdate = true; }); });
}
addEventListener('resize', resize);

function txt(s, x, y, align = 'left', color = '#fff', size = 17) {
  og.font = `${size}px 'Share Tech Mono', ui-monospace, monospace`;
  og.textAlign = align;
  og.lineWidth = 3.5;
  og.strokeStyle = 'rgba(0,0,0,0.85)';
  og.strokeText(s, x, y);
  og.fillStyle = color;
  og.fillText(s, x, y);
}

function drawOSD(tel, linkQ) {
  og.setTransform(dpr, 0, 0, dpr, 0, 0);
  og.clearRect(0, 0, osdW, osdH);
  if (game.state === 'start' || game.state === 'boot') return;
  const W = osdW, H = osdH, small = W < 640;
  const fs = small ? 13 : 17, lh = fs + 5;
  const padX = Math.max(16, W * 0.05), top = Math.max(60, H * 0.08) + (small ? 6 : 0), bot = H - Math.max(isTouch ? 210 : 40, H * 0.07);
  const analog = settings.video === 'analog';
  const jx = analog ? (Math.random() - 0.5) * 1.2 : 0;
  const fpv = game.view === 'fpv';
  const cell = tel.cell;
  const batCol = cell < 3.3 ? '#ff5b4f' : cell < 3.55 ? '#ffb21e' : '#fff';
  const P = PRESETS[settings.preset];

  if (game.state === 'replay') {
    txt('REPLAY', W / 2, top, 'center', '#ff5b4f', fs + 4);
    return;
  }
  // Coluna esquerda
  txt(`${tel.mode}`, padX + jx, top, 'left', '#fff', fs);
  txt(`LQ ${linkQ.toFixed(0).padStart(3)}`, padX + jx, top + lh, 'left', linkQ < 40 ? '#ff5b4f' : '#fff', fs);
  txt(`${P.short}`, padX + jx, top + lh * 2, 'left', '#9fb0bd', fs - 3);
  // Coluna direita: bateria
  txt(`${tel.volt.toFixed(1)}V`, W - padX + jx, top, 'right', batCol, fs + 2);
  txt(`${cell.toFixed(2)}V/c`, W - padX + jx, top + lh, 'right', batCol, fs);
  txt(`${tel.amps.toFixed(1)}A ${tel.mah.toFixed(0)}mAh`, W - padX + jx, top + lh * 2, 'right', '#fff', fs);
  // Cronômetro de voo
  txt(`${tel.armed ? '▶' : '■'} ${fmt(tel.armTime).slice(0, 5)}`, W / 2 + jx, top, 'center', tel.armed ? '#fff' : '#9fb0bd', fs);

  // Horizonte artificial e mira (só FPV de corpo fixo)
  const cx = W / 2, cy = H / 2;
  if (fpv && !P.gimbal) {
    og.save();
    og.translate(cx, cy);
    og.rotate(-tel.roll);
    const pitchPx = (tel.pitch + perPreset().camTilt * D2R) * (H / (camera.fov * D2R));
    og.strokeStyle = 'rgba(255,255,255,0.85)'; og.lineWidth = 2;
    og.shadowColor = 'rgba(0,0,0,0.9)'; og.shadowBlur = 3;
    og.beginPath();
    const hw = Math.min(W * 0.12, 120);
    og.moveTo(-hw, pitchPx); og.lineTo(-hw * 0.3, pitchPx); og.moveTo(hw * 0.3, pitchPx); og.lineTo(hw, pitchPx);
    og.stroke();
    og.restore();
  }
  og.strokeStyle = '#fff'; og.lineWidth = 2;
  og.shadowColor = 'rgba(0,0,0,0.9)'; og.shadowBlur = 3;
  og.beginPath(); og.moveTo(cx - 14, cy); og.lineTo(cx - 5, cy); og.moveTo(cx + 5, cy); og.lineTo(cx + 14, cy); og.moveTo(cx, cy - 5); og.lineTo(cx, cy - 12); og.stroke();
  og.shadowBlur = 0;

  // Rodapé
  txt(`ALT ${tel.alt.toFixed(1)}m`, padX + jx, bot - lh, 'left', '#fff', fs);
  txt(`${tel.vz >= 0 ? '↑' : '↓'}${Math.abs(tel.vz).toFixed(1)}m/s`, padX + jx, bot, 'left', '#fff', fs);
  txt(`${(tel.speed * 3.6).toFixed(0)}km/h`, W - padX + jx, bot - lh, 'right', '#fff', fs + 2);
  txt(`THR ${(input.thr * 100).toFixed(0).padStart(3)}%`, W - padX + jx, bot, 'right', '#fff', fs);
  txt(`${tel.gload.toFixed(1)}G`, W - padX + jx, bot - lh * 2, 'right', '#9fb0bd', fs - 2);

  // Seta para home / próximo objetivo
  let goal = null, goalLabel = '';
  if (game.race) { const g = world.gates[game.race.next]; goal = { x: g.x, y: g.cy, z: g.z }; goalLabel = `G${game.race.next + 1}`; }
  else if (game.land) { const p = world.pads[game.land.target]; goal = { x: p.x, y: p.y, z: p.z }; goalLabel = `P${p.label}`; }
  else { goal = { x: world.spawn.x, y: 0, z: world.spawn.z }; goalLabel = 'H'; }
  const s = drone.s;
  const dx = goal.x - s.pos.x, dzv = goal.z - s.pos.z;
  const dist = Math.hypot(dx, dzv);
  const bearing = Math.atan2(-dx, -dzv);
  const rel = bearing - tel.heading;
  og.save();
  og.translate(W / 2, bot - lh * 0.4);
  og.rotate(-rel);
  og.fillStyle = '#fff'; og.strokeStyle = 'rgba(0,0,0,0.85)'; og.lineWidth = 2;
  og.beginPath(); og.moveTo(0, -12); og.lineTo(8, 8); og.lineTo(0, 3); og.lineTo(-8, 8); og.closePath(); og.stroke(); og.fill();
  og.restore();
  txt(`${goalLabel} ${dist < 1000 ? dist.toFixed(0) + 'm' : (dist / 1000).toFixed(2) + 'km'}`, W / 2 + jx, bot + lh * 0.9, 'center', '#fff', fs);

  // Corrida
  if (game.race) {
    const r = game.race;
    const best = store.get(bestLapKey(), null);
    txt(`PORTAL ${r.next + 1}/${world.gates.length}   VOLTA ${Math.max(1, r.lap)}/${r.laps}`, W / 2, top + lh, 'center', '#ffb21e', fs);
    txt(`${r.started ? fmt(r.t) : 'PASSE PELO PORTAL 1'}${best ? '   MELHOR ' + fmt(best) : ''}`, W / 2, top + lh * 2, 'center', '#fff', fs);
    if (r.split !== null && r.started && r.t < 3) txt(`${r.split <= 0 ? '−' : '+'}${Math.abs(r.split).toFixed(2)}s`, W / 2, top + lh * 3, 'center', r.split <= 0 ? '#4bd980' : '#ff5b4f', fs + 2);
  }
  if (game.land) {
    const L = game.land;
    txt(`ALVO ${world.pads[L.target].label}   PONTOS ${L.score}`, W / 2, top + lh, 'center', '#5cc8ff', fs);
    if (L.hold > 0) txt(`SEGURE ${(1.2 - L.hold).toFixed(1)}s`, W / 2, top + lh * 2, 'center', '#4bd980', fs);
  }

  // Alertas
  const warn = [];
  if (!tel.armed && !tel.crashed) warn.push(['DESARMADO — ESPAÇO / BOTÃO A', '#fff']);
  if (tel.crashed) warn.push(['CRASH', '#ff5b4f']);
  if (tel.armed && cell < 3.3) warn.push(['POUSE AGORA', '#ff5b4f']);
  else if (tel.armed && cell < 3.5) warn.push(['BATERIA BAIXA', '#ffb21e']);
  if (linkQ < 25) warn.push(['SINAL FRACO', '#ff5b4f']);
  if (tel.armed && tel.vrs > 0.5) warn.push(['PROP WASH', '#ffb21e']);
  if (!tel.armed && tel.upY < 0.3 && !tel.crashed) warn.push(['VIRADO — R PARA RESETAR', '#ffb21e']);
  const blink = Math.floor(performance.now() / 400) % 2 === 0;
  warn.forEach(([w, c], i) => { if (blink || i > 0 || !tel.armed) txt(w, W / 2, cy + H * 0.16 + i * lh, 'center', c, fs + 1); });
}

function drawMinimap() {
  if (!settings.showMap) return;
  const S = mm.width, R = S / 2;
  const s = drone.s;
  const scale = R / 160;
  mg.setTransform(1, 0, 0, 1, 0, 0);
  mg.clearRect(0, 0, S, S);
  mg.save();
  mg.beginPath(); mg.arc(R, R, R - 2, 0, Math.PI * 2); mg.clip();
  mg.fillStyle = 'rgba(8, 12, 15, 0.7)'; mg.fillRect(0, 0, S, S);
  mg.translate(R, R);
  const fwd = Q.rot(s.q, { x: 0, y: 0, z: -1 });
  const hdg = Math.atan2(-fwd.x, -fwd.z);
  mg.rotate(hdg);
  const P = (x, z) => [(x - s.pos.x) * scale, (z - s.pos.z) * scale];
  mg.strokeStyle = 'rgba(255,255,255,0.08)'; mg.lineWidth = 1;
  for (let r = 50; r <= 250; r += 50) { const [cx, cz] = P(world.spawn.x, world.spawn.z); mg.beginPath(); mg.arc(cx, cz, r * scale, 0, Math.PI * 2); mg.stroke(); }
  mg.fillStyle = 'rgba(120, 140, 155, 0.75)';
  for (const st of world.structures) {
    mg.save(); const [x, z] = P(st.x, st.z); mg.translate(x, z); mg.rotate(-st.yaw); mg.fillRect((-st.w / 2) * scale, (-st.d / 2) * scale, st.w * scale, st.d * scale); mg.restore();
  }
  if (game.race) {
    mg.strokeStyle = 'rgba(255, 178, 30, 0.35)'; mg.lineWidth = 2; mg.beginPath();
    world.gates.forEach((g, i) => { const [x, z] = P(g.x, g.z); i ? mg.lineTo(x, z) : mg.moveTo(x, z); });
    mg.closePath(); mg.stroke();
  }
  world.gates.forEach((g, i) => {
    const [x, z] = P(g.x, g.z);
    const next = game.race && game.race.next === i;
    mg.fillStyle = next ? '#ffb21e' : 'rgba(255,140,40,0.6)';
    mg.beginPath(); mg.arc(x, z, next ? 6 : 3.5, 0, Math.PI * 2); mg.fill();
  });
  world.pads.forEach((p, i) => {
    const [x, z] = P(p.x, p.z);
    mg.strokeStyle = game.land && game.land.target === i ? '#5cc8ff' : 'rgba(255,255,255,0.4)';
    mg.lineWidth = 2; mg.beginPath(); mg.arc(x, z, 5, 0, Math.PI * 2); mg.stroke();
  });
  mg.restore();
  mg.fillStyle = '#fff'; mg.strokeStyle = '#000'; mg.lineWidth = 2;
  mg.beginPath(); mg.moveTo(R, R - 10); mg.lineTo(R + 7, R + 8); mg.lineTo(R, R + 4); mg.lineTo(R - 7, R + 8); mg.closePath(); mg.stroke(); mg.fill();
  mg.strokeStyle = 'rgba(255,255,255,0.25)'; mg.lineWidth = 2; mg.beginPath(); mg.arc(R, R, R - 2, 0, Math.PI * 2); mg.stroke();
}

function drawBlackbox() {
  if (!settings.showBlackbox) return;
  const W = bb.width, H = bb.height, b = blackbox.buf, n = blackbox.n;
  bg.clearRect(0, 0, W, H);
  const rows = [['ROLL', 0], ['PITCH', 2], ['YAW', 4]];
  const rh = (H - 70) / 3;
  bg.font = '20px "Share Tech Mono", monospace';
  rows.forEach(([name, o], r) => {
    const y0 = 10 + r * rh, mid = y0 + rh / 2;
    bg.strokeStyle = 'rgba(255,255,255,0.08)'; bg.beginPath(); bg.moveTo(0, mid); bg.lineTo(W, mid); bg.stroke();
    let maxv = 1;
    for (let i = 0; i < n; i++) maxv = Math.max(maxv, Math.abs(b[i * 10 + o]), Math.abs(b[i * 10 + o + 1]));
    for (const [k, col] of [[o, '#ffb21e'], [o + 1, '#5cc8ff']]) {
      bg.strokeStyle = col; bg.lineWidth = 2; bg.beginPath();
      for (let i = 0; i < n; i++) {
        const idx = (blackbox.i + i) % n;
        const v = b[idx * 10 + k];
        const x = (i / (n - 1)) * W, y = mid - (v / maxv) * (rh / 2 - 4);
        i ? bg.lineTo(x, y) : bg.moveTo(x, y);
      }
      bg.stroke();
    }
    bg.fillStyle = '#9fb0bd'; bg.fillText(`${name} ±${(maxv / D2R).toFixed(0)}°/s`, 8, y0 + 20);
  });
  bg.fillStyle = '#ffb21e'; bg.fillText('setpoint', W - 210, 30); bg.fillStyle = '#5cc8ff'; bg.fillText('gyro', W - 90, 30);
  const last = ((blackbox.i - 1 + n) % n) * 10;
  for (let m = 0; m < 4; m++) {
    const v = b[last + 6 + m];
    const x = 10 + m * ((W - 20) / 4), w = (W - 20) / 4 - 10;
    bg.fillStyle = 'rgba(255,255,255,0.1)'; bg.fillRect(x, H - 52, w, 18);
    bg.fillStyle = v > 0.97 ? '#ff5b4f' : '#4bd980'; bg.fillRect(x, H - 52, w * clamp(v, 0, 1), 18);
    bg.fillStyle = '#e7edf1'; bg.fillText(`M${m + 1} ${(v * 100).toFixed(0)}%`, x, H - 12);
  }
}

function drawNoise(level) {
  if (level <= 0.01) { noiseC.style.opacity = 0; return; }
  const d = noiseImg.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.random() * 255;
    d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  // Faixas horizontais de interferência.
  const bands = Math.floor(level * 6);
  for (let k = 0; k < bands; k++) {
    const y = Math.floor(Math.random() * 90);
    for (let x = 0; x < 160; x++) { const o = (y * 160 + x) * 4; d[o] = d[o + 1] = d[o + 2] = 255; }
  }
  ng.putImageData(noiseImg, 0, 0);
  noiseC.style.opacity = clamp(level, 0, 1);
}

// ======================================================================
// Menus
// ======================================================================
function cardHTML(sel, key, title, small, spec) {
  return `<button class="card" data-${sel}="${key}" aria-pressed="false"><b>${title}</b><small>${small}</small>${spec ? `<span class="spec">${spec}</span>` : ''}</button>`;
}
function buildStart() {
  $('presetCards').innerHTML = Object.entries(PRESETS).map(([k, p]) => {
    const twr = (p.tmax * 4) / (p.mass * 9.81);
    return cardHTML('preset', k, p.name, p.desc, `TWR ${twr.toFixed(1)} · ${p.cells}S ${p.capacity}mAh · ${MODES[p.mode]}`);
  }).join('');
  $('activityCards').innerHTML = Object.entries(ACTIVITIES).map(([k, a]) => {
    let rec = '';
    if (k === 'race') { const b = store.get('best.' + settings.preset, null); rec = b ? `Recorde: ${fmt(b)}` : 'Sem recorde ainda'; }
    if (k === 'land') { const b = store.get('bestLand.' + settings.preset, 0); rec = b ? `Recorde: ${b} pts` : 'Sem recorde ainda'; }
    return cardHTML('activity', k, a.name, a.desc, rec);
  }).join('');
  document.querySelectorAll('[data-preset]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.preset === settings.preset));
  document.querySelectorAll('[data-activity]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.activity === settings.activity));
}
$('presetCards').addEventListener('click', (e) => { const b = e.target.closest('[data-preset]'); if (b) { selectPreset(b.dataset.preset); buildStart(); } });
$('activityCards').addEventListener('click', (e) => { const b = e.target.closest('[data-activity]'); if (b) { settings.activity = b.dataset.activity; save(); buildStart(); } });
$('goBtn').addEventListener('click', () => startFlying());

function showStart() {
  game.state = 'start';
  buildStart();
  updatePadStatus();
  $('start').hidden = false;
  $('topbar').hidden = true;
  $('touch').hidden = true;
  $('menu').hidden = true; $('crash').hidden = true; $('results').hidden = true; $('replayBar').hidden = true;
}
function startFlying() {
  sound.init();
  $('start').hidden = true;
  $('topbar').hidden = false;
  $('touch').hidden = !isTouch;
  game.state = 'fly';
  game.view = settings.view;
  document.activeElement?.blur();
  resetFlight();
  toast(isTouch ? 'Toque em ARMAR para ligar os motores' : 'Espaço para armar', 2.5);
}

let menuTab = 'voo';
const TABS = { voo: 'Voo', camera: 'Câmera', ambiente: 'Ambiente', controles: 'Controles', video: 'Gráficos e som' };
function openMenu(tab) {
  if (tab) menuTab = tab;
  game.resumeTo = game.state === 'start' ? 'start' : game.state;
  game.state = 'menu';
  $('start').hidden = true;
  $('menu').hidden = false;
  $('crash').hidden = true;
  $('results').hidden = true;
  renderMenu();
}
function closeMenu() {
  $('menu').hidden = true;
  document.activeElement?.blur();
  applySettingsToDrone();
  save();
  if (game.resumeTo === 'start') return showStart();
  game.state = game.resumeTo === 'crash' ? 'crash' : game.resumeTo === 'results' ? 'results' : 'fly';
  if (game.state === 'crash') $('crash').hidden = false;
  if (game.state === 'results') $('results').hidden = false;
}

function field(id, label, html, out = '') { return `<label class="field" for="${id}"><span>${label}<output id="${id}-o">${out}</output></span>${html}</label>`; }
function range(id, label, min, max, step, val, fmtv = (v) => v) { return field(id, label, `<input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}">`, fmtv(val)); }
function select(id, label, opts, val) { return field(id, label, `<select id="${id}">${opts.map(([v, t]) => `<option value="${v}"${String(v) === String(val) ? ' selected' : ''}>${t}</option>`).join('')}</select>`); }
function check(id, label, val) { return `<label class="check"><input type="checkbox" id="${id}"${val ? ' checked' : ''}>${label}</label>`; }

function renderMenu() {
  $('tabs').innerHTML = Object.entries(TABS).map(([k, t]) => `<button class="tab" role="tab" aria-selected="${k === menuTab}" data-tab="${k}">${t}</button>`).join('');
  const pp = perPreset();
  const P = PRESETS[settings.preset];
  let h = '';
  if (menuTab === 'voo') {
    const maxR = (r) => `${rateDps(1, r).toFixed(0)}°/s`;
    h += `<div class="group">Aeronave e modo</div>`;
    h += select('f-preset', 'Aeronave', Object.entries(PRESETS).map(([k, p]) => [k, p.name]), settings.preset);
    h += select('f-mode', 'Modo de voo', [['acro', 'ACRO (taxa, manual)'], ['angle', 'ANGLE (auto-nivelado)'], ['pos', 'GPS (segura posição)']], pp.mode);
    h += select('f-activity', 'Atividade', Object.entries(ACTIVITIES).map(([k, a]) => [k, a.name]), settings.activity);
    h += range('f-maxangle', 'Ângulo máximo (ANGLE/GPS)', 15, 80, 1, pp.maxAngle, (v) => `${v}°`);
    h += `<div class="group">Rates (Betaflight)</div>`;
    for (const ax of ['roll', 'pitch', 'yaw']) {
      const r = pp.rates[ax];
      h += range(`r-${ax}-rc`, `${ax.toUpperCase()} · RC Rate`, 0.3, 2.5, 0.01, r.rcRate, (v) => Number(v).toFixed(2));
      h += range(`r-${ax}-sr`, `${ax.toUpperCase()} · Super Rate`, 0, 0.95, 0.01, r.superRate, (v) => Number(v).toFixed(2));
      h += range(`r-${ax}-ex`, `${ax.toUpperCase()} · Expo`, 0, 1, 0.01, r.expo, (v) => Number(v).toFixed(2));
      h += `<p class="note" id="r-${ax}-max">Taxa máxima ${ax}: ${maxR(r)}</p>`;
    }
    h += `<div class="btns" style="grid-column:1/-1;justify-content:flex-start"><button class="ghost mini" data-act="rates-default">Restaurar rates do preset</button></div>`;
  } else if (menuTab === 'camera') {
    h += select('c-view', 'Câmera', VIEWS.map((v) => [v, VIEW_NAMES[v]]), game.view);
    h += select('c-video', 'Vídeo', [['digital', 'Digital HD (limpo)'], ['analog', 'Analógico (ruído, alcance)']], settings.video);
    if (P.gimbal) h += range('c-gimbal', 'Inclinação do gimbal', -90, 20, 1, gimbalPitch, (v) => `${v}°`);
    else h += range('c-tilt', 'Inclinação da câmera FPV (uptilt)', 0, 60, 1, pp.camTilt, (v) => `${v}°`);
    h += range('c-fov', 'Campo de visão horizontal', 70, 140, 1, pp.fov, (v) => `${v}°`);
    h += check('c-props', 'Mostrar hélices na imagem FPV', settings.propsInView);
    h += `<p class="note">Uptilt alto (30–45°) é para voar rápido: a câmera fica nivelada quando o drone está inclinado à frente. Para iniciar, use 10–20°.</p>`;
  } else if (menuTab === 'ambiente') {
    h += range('e-wind', 'Vento médio', 0, 15, 0.5, settings.wind.speed, (v) => `${v} m/s`);
    h += range('e-dir', 'Vem de (direção)', 0, 359, 1, settings.wind.dir, (v) => `${v}°`);
    h += range('e-gust', 'Rajadas', 0, 1, 0.05, settings.wind.gust, (v) => `${Math.round(v * 100)}%`);
    h += range('e-time', 'Hora do dia', 6, 19.5, 0.25, settings.timeOfDay, (v) => { const hh = Math.floor(v), mm2 = Math.round((v - hh) * 60); return `${hh}h${String(mm2).padStart(2, '0')}`; });
    h += `<div class="group">Física</div>`;
    h += check('e-wash', 'Prop wash (turbulência ao descer no próprio fluxo)', settings.propWash);
    h += check('e-ge', 'Efeito solo (mais empuxo perto do chão)', settings.groundEffect);
    h += check('e-bat', 'Bateria realista (queda de tensão e autonomia)', settings.battery);
  } else if (menuTab === 'controles') {
    const gp = navigator.getGamepads ? [...navigator.getGamepads()].find(Boolean) : null;
    h += `<p class="note">${gp ? `Controle: <b>${gp.id.slice(0, 70)}</b> · ${gp.axes.length} eixos · ${gp.buttons.length} botões` : 'Nenhum controle detectado. Conecte um gamepad ou rádio (EdgeTX/OpenTX em modo Joystick USB) e mexa um stick.'}</p>`;
    h += `<div class="btns" style="grid-column:1/-1;justify-content:flex-start"><button class="ghost mini" data-act="map-gamepad">Perfil gamepad (Xbox/PS)</button><button class="ghost mini" data-act="map-radio">Perfil rádio RC (AETR)</button></div>`;
    h += `<div class="map-table">`;
    const names = { thr: 'Acelerador', yaw: 'Yaw', pitch: 'Pitch', roll: 'Roll' };
    const nAxes = Math.max(gp ? gp.axes.length : 4, 4);
    for (const ch of ['thr', 'yaw', 'pitch', 'roll']) {
      const m = settings.map[ch];
      h += `<div class="map-row"><b>${names[ch]}</b><select id="m-${ch}" aria-label="Eixo ${names[ch]}">${Array.from({ length: nAxes }, (_, i) => `<option value="${i}"${i === m.axis ? ' selected' : ''}>Eixo ${i}</option>`).join('')}</select>
        <label class="check"><input type="checkbox" id="m-${ch}-inv"${m.inv ? ' checked' : ''}>Inverter</label>
        <button class="ghost mini" data-detect="${ch}">Detectar</button><div class="bar"><i id="m-${ch}-bar"></i></div></div>`;
    }
    const am = settings.map.arm;
    h += `<div class="map-row"><b>Armar</b><select id="m-arm">${['button', 'axis'].map((k) => `<option value="${k}"${am.kind === k ? ' selected' : ''}>${k === 'button' ? 'Botão (alterna)' : 'Chave / canal'}</option>`).join('')}</select>
      <input type="number" id="m-arm-i" min="0" max="31" value="${am.index}" aria-label="Índice" style="width:70px"><span></span><div class="bar"><i id="m-arm-bar"></i></div></div>`;
    h += `</div>`;
    h += range('m-dead', 'Zona morta', 0, 0.15, 0.005, settings.deadband, (v) => `${Math.round(v * 100)}%`);
    h += `<p class="note">“Detectar”: clique e mova só aquele stick até o fim. Botões do gamepad: A armar · B reset · X modo · Y câmera · Start menu. Teclado: W/S acelerador, A/D yaw, setas pitch/roll, Shift acelera o ajuste do acelerador.</p>`;
  } else {
    h += select('v-quality', 'Qualidade gráfica', [['low', 'Baixa (celular modesto)'], ['medium', 'Média (bloom e reflexo na água)'], ['high', 'Alta (grama, sombras 2K, antisserrilhado)'], ['ultra', 'Ultra (PC com placa de vídeo)']], settings.quality);
    h += `<p class="note">Grama, reflexo da água e reflexo do sol mudam ao recarregar a página.</p>`;
    h += range('v-volume', 'Volume', 0, 1, 0.05, settings.volume, (v) => `${Math.round(v * 100)}%`);
    h += check('v-map', 'Minimapa (N)', settings.showMap);
    h += check('v-bb', 'Blackbox ao vivo: setpoint × gyro e motores (B)', settings.showBlackbox);
  }
  $('pane').innerHTML = h;
}

$('tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) { menuTab = b.dataset.tab; renderMenu(); } });
$('pane').addEventListener('input', (e) => {
  const el = e.target, id = el.id, v = el.type === 'checkbox' ? el.checked : el.value;
  const num = Number(v);
  const pp = perPreset();
  const o = $(id + '-o');
  const setOut = (t) => { if (o) o.textContent = t; };
  if (id === 'f-preset') { selectPreset(v); renderMenu(); return; }
  if (id === 'f-mode') { pp.mode = v; drone.cfg.mode = v; drone.resetController(); if (v === 'pos') kb.thr = 0.5; syncTouchThrottleIfIdle(); }
  if (id === 'f-activity') { settings.activity = v; resetFlight(); }
  if (id === 'f-maxangle') { pp.maxAngle = num; setOut(`${num}°`); }
  const rm = id.match(/^r-(roll|pitch|yaw)-(rc|sr|ex)$/);
  if (rm) {
    const r = pp.rates[rm[1]];
    r[{ rc: 'rcRate', sr: 'superRate', ex: 'expo' }[rm[2]]] = num;
    setOut(num.toFixed(2));
    $(`r-${rm[1]}-max`).textContent = `Taxa máxima ${rm[1]}: ${rateDps(1, r).toFixed(0)}°/s`;
  }
  if (id === 'c-view') { game.view = v; settings.view = v; }
  if (id === 'c-video') settings.video = v;
  if (id === 'c-tilt') { pp.camTilt = num; setOut(`${num}°`); }
  if (id === 'c-gimbal') { gimbalPitch = num; settings.gimbal = num; setOut(`${num}°`); }
  if (id === 'c-fov') { pp.fov = num; setOut(`${num}°`); }
  if (id === 'c-props') settings.propsInView = v;
  if (id === 'e-wind') { settings.wind.speed = num; setOut(`${num} m/s`); }
  if (id === 'e-dir') { settings.wind.dir = num; setOut(`${num}°`); }
  if (id === 'e-gust') { settings.wind.gust = num; setOut(`${Math.round(num * 100)}%`); }
  if (id === 'e-time') { settings.timeOfDay = num; const hh = Math.floor(num); setOut(`${hh}h${String(Math.round((num - hh) * 60)).padStart(2, '0')}`); setTimeOfDay(num); }
  if (id === 'e-wash') settings.propWash = v;
  if (id === 'e-ge') settings.groundEffect = v;
  if (id === 'e-bat') settings.battery = v;
  const mm2 = id.match(/^m-(thr|yaw|pitch|roll)(-inv)?$/);
  if (mm2) { if (mm2[2]) settings.map[mm2[1]].inv = v; else settings.map[mm2[1]].axis = num; }
  if (id === 'm-arm') settings.map.arm.kind = v;
  if (id === 'm-arm-i') settings.map.arm.index = num;
  if (id === 'm-dead') { settings.deadband = num; setOut(`${Math.round(num * 100)}%`); }
  if (id === 'v-quality') { settings.quality = v; resize(); }
  if (id === 'v-volume') { settings.volume = num; setOut(`${Math.round(num * 100)}%`); }
  if (id === 'v-map') { settings.showMap = v; $('minimap').hidden = !v; }
  if (id === 'v-bb') { settings.showBlackbox = v; $('blackbox').hidden = !v; }
  applySettingsToDrone();
  save();
});

let detecting = null;
$('pane').addEventListener('click', (e) => {
  const d = e.target.closest('[data-detect]');
  if (d) {
    const gp = navigator.getGamepads ? [...navigator.getGamepads()].find(Boolean) : null;
    if (!gp) { d.textContent = 'Sem controle'; return; }
    detecting = { ch: d.dataset.detect, base: gp.axes.slice(), btn: d, t: performance.now() };
    d.textContent = 'Mova o stick…';
  }
});

// Ações dos botões (delegação global)
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const a = b.dataset.act;
  if (b.closest('#topbar, #touchBtns, #crash, #results')) b.blur();
  if (a === 'resume') return closeMenu();
  if (a === 'settings') return openMenu('voo');
  if (a === 'home') { $('menu').hidden = true; applySettingsToDrone(); save(); return showStart(); }
  if (a === 'rates-default') { const pp = perPreset(); pp.rates = JSON.parse(JSON.stringify(PRESETS[settings.preset].rates)); applySettingsToDrone(); save(); return renderMenu(); }
  if (a === 'map-gamepad') { settings.map = JSON.parse(JSON.stringify(DEFAULT_MAP)); save(); return renderMenu(); }
  if (a === 'map-radio') { settings.map = JSON.parse(JSON.stringify(RADIO_MAP)); save(); return renderMenu(); }
  if (a === 'rp-play') { replay.playing = !replay.playing; return; }
  if (a === 'rp-exit') return exitReplay();
  if (a === 'rp-rec') {
    if (replay.rec || media.recording) return;
    replay.t = 0; replay.playing = true;
    replay.rec = media.startRecording();
    if (!replay.rec) toast('Este navegador não grava vídeo', 2);
    return;
  }
  action(a);
});
$('rpSeek').addEventListener('input', (e) => { replay.t = (Number(e.target.value) / 1000) * (recorder.count / 60); });

function updateMenuLive() {
  if (game.state !== 'menu' || menuTab !== 'controles') return;
  const gp = navigator.getGamepads ? [...navigator.getGamepads()].find(Boolean) : null;
  if (!gp) return;
  for (const ch of ['thr', 'yaw', 'pitch', 'roll']) {
    const bar = $(`m-${ch}-bar`);
    if (bar) bar.style.left = `calc(${((axisVal(gp, settings.map[ch]) + 1) / 2) * 100}% - 1px)`;
  }
  const ab = $('m-arm-bar'), am = settings.map.arm;
  if (ab) ab.style.left = `calc(${am.kind === 'axis' ? ((gp.axes[am.index] ?? -1) + 1) * 50 : gp.buttons[am.index]?.pressed ? 100 : 0}% - 1px)`;
  if (detecting) {
    let best = -1, bestD = 0.5;
    gp.axes.forEach((v, i) => { const d = Math.abs(v - detecting.base[i]); if (d > bestD) { bestD = d; best = i; } });
    if (best >= 0) {
      const m = settings.map[detecting.ch];
      m.axis = best;
      const moved = gp.axes[best] - detecting.base[best];
      // Acelerador e pitch para cima/frente devem dar valor positivo.
      m.inv = moved < 0;
      detecting = null;
      save();
      renderMenu();
    } else if (performance.now() - detecting.t > 8000) { detecting.btn.textContent = 'Detectar'; detecting = null; }
  }
}

// ======================================================================
// Loop principal
// ======================================================================
let last = performance.now();
const flyby = { a: 0 };

function updateModel(pose, dt) {
  if (!model) return;
  model.position.set(pose.pos.x, pose.pos.y, pose.pos.z);
  model.quaternion.set(pose.q.x, pose.q.y, pose.q.z, pose.q.w);
  const om = drone.d.omegaMax;
  model.userData.props.forEach((p, i) => {
    const m = pose.m[i];
    p.angle += p.spin * m * om * dt;
    // Estroboscópico: acima de certa rotação mostra o disco borrado.
    const blur = clamp((m - 0.08) / 0.25, 0, 1);
    p.blades.rotation.y = p.angle % (Math.PI * 2) + (blur > 0.5 ? Math.random() * 6.28 : 0);
    p.bladeMat.opacity = 1 - blur * 0.85;
    p.disc.material.opacity = blur * 0.32;
  });
  if (model.userData.gimbal) {
    // Gimbal de 3 eixos: segue só o yaw do drone e mantém o pitch escolhido.
    const f = tmpV.set(0, 0, -1).applyQuaternion(model.quaternion);
    const want = tmpQ.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-f.x, -f.z)).multiply(tmpQ2.setFromAxisAngle(new THREE.Vector3(1, 0, 0), gimbalPitch * D2R));
    gimbalQ.slerp(want, 1 - Math.exp(-dt * 12));
    const g = model.userData.gimbal;
    g.quaternion.copy(model.quaternion).invert().multiply(gimbalQ);
  }
  // Na vista FPV a câmera fica dentro do corpo: esconde as peças que bloqueariam a imagem.
  const inside = game.view === 'fpv' && game.state !== 'start' && game.state !== 'replay';
  if (model.userData.cam) model.userData.cam.visible = !inside;
  if (model.userData.gimbal) model.userData.gimbal.visible = !inside;
  model.userData.props.forEach((p) => { p.blades.visible = p.disc.visible = !inside || settings.propsInView; });
}

function frame(now) {
  requestAnimationFrame(frame);
  const realDt = Math.min(0.5, (now - last) / 1000);
  const dt = Math.min(0.05, realDt);
  last = now;
  updateInput(dt);
  updateMenuLive();
  if (game.toastT > 0) { game.toastT -= dt; if (game.toastT <= 0) $('toast').classList.remove('show'); }

  let pose;
  if (game.state === 'fly' || game.state === 'crash' || game.state === 'results') {
    game.prevPos = { ...drone.s.pos };
    if (game.state === 'fly') updateShot(dt);
    drone.update(dt, input);
    if (game.state === 'fly') {
      updateRace();
      updateLanding(dt);
    }
    recorder.push(dt);
    blackbox.push(dt);
    pose = { pos: drone.s.pos, q: drone.s.q, m: drone.s.motor.map((x) => x / drone.d.omegaMax) };
  } else if (game.state === 'replay') {
    const dur = recorder.count / 60;
    if (replay.playing) replay.t += dt;
    if (replay.t >= dur) {
      if (replay.rec) { replay.rec = false; replay.playing = false; replay.t = dur - 1 / 60; media.stopRecording(() => toast('Replay salvo na galeria', 1.8)); }
      else replay.t = 0;
    }
    const fi = clamp(Math.floor(replay.t * 60), 0, recorder.count - 1);
    pose = recorder.frame(fi);
    $('rpSeek').value = String(Math.round((replay.t / Math.max(dur, 0.01)) * 1000));
    $('rpTime').textContent = `${replay.t.toFixed(1)} / ${dur.toFixed(1)} s`;
    $('rpPlay').textContent = replay.playing ? 'Pausar' : 'Tocar';
  } else {
    pose = { pos: drone.s.pos, q: drone.s.q, m: [0, 0, 0, 0] };
  }

  if (game.state === 'start' || game.state === 'boot' || (game.state === 'menu' && game.resumeTo === 'start')) {
    // Sobrevoo cinematográfico atrás da tela inicial.
    flyby.a += dt * 0.035;
    const r = 210;
    camera.position.set(40 + Math.cos(flyby.a) * r, 55 + Math.sin(flyby.a * 2) * 10, 120 + Math.sin(flyby.a) * r);
    camera.lookAt(40, 10, 140);
    setFovH(85);
    camera.updateProjectionMatrix();
    updateModel(pose, dt);
  } else {
    updateModel(pose, dt);
    updateCamera(dt, pose);
  }

  const focus = pose.pos;
  sun.target.position.set(focus.x, focus.y, focus.z);
  sun.position.set(focus.x + sunDir.x * 200, focus.y + sunDir.y * 200, focus.z + sunDir.z * 200);
  const flying = game.state === 'fly' || game.state === 'crash' || game.state === 'results';
  if (game.race) { const gv = gateViz[game.race.next]; if (gv) gv.glow.material.opacity = 0.08 + 0.08 * Math.sin(now / 180); }

  // Lente: grande-angular com distorção na FPV, mais limpa nas outras câmeras.
  const fpvLens = game.view === 'fpv' && !PRESETS[settings.preset].gimbal && (game.state === 'fly' || game.state === 'crash' || game.state === 'results');
  const L = post.lens;
  L.distortion.value = fpvLens ? clamp((perPreset().fov - 90) / 160, 0, 0.32) : 0;
  L.aberration.value = fpvLens ? 0.0035 : 0.001;
  L.vignette.value = fpvLens ? 0.5 : 0.25;
  L.grain.value = fpvLens && settings.video === 'analog' ? 0.06 : 0.012;
  scenery?.update(realDt, { day: game.day ?? 1, wind: settings.wind.speed });
  // Posição do sol na tela e se está encoberto (prédios/terreno) para o reflexo na lente.
  {
    const sp = tmpV.copy(sunDir).multiplyScalar(3000).add(camera.position).project(camera);
    let amt = 0;
    if (sp.z < 1 && Math.abs(sp.x) < 1.3 && Math.abs(sp.y) < 1.3 && sunDir.y > -0.02) {
      const cp = camera.position, far = { x: cp.x + sunDir.x * 400, y: cp.y + sunDir.y * 400, z: cp.z + sunDir.z * 400 };
      amt = (1 - world.lineOfSight(cp, far)) * clamp(1.3 - Math.max(Math.abs(sp.x), Math.abs(sp.y)), 0, 1) * (game.day ?? 1);
    }
    L.sunUv.value.set(sp.x * 0.5 + 0.5, sp.y * 0.5 + 0.5);
    L.sunAmt.value += (amt - L.sunAmt.value) * Math.min(1, realDt * 8);
  }
  post.render(realDt);
  media.afterRender(() => post.render(0));
  if (media.recording) $('recTime').textContent = fmtDur(media.recTime);

  const tel = drone.telemetry();
  const pl = world.pilot;
  const dist = Math.hypot(drone.s.pos.x - pl.x, drone.s.pos.y - pl.y, drone.s.pos.z - pl.z);
  const blocked = flying ? world.lineOfSight(pl, drone.s.pos) : 0;
  const linkQ = clamp(100 - Math.max(0, dist - 150) / 6 - blocked * 45, 0, 100);
  game.flash = Math.max(0, game.flash - realDt * 1.6);
  let noise = 0;
  if (game.view === 'fpv' && flying) {
    if (settings.video === 'analog') noise = 0.06 + clamp((100 - linkQ) / 80, 0, 1) * 0.9 + game.flash;
    else noise = game.flash * 0.6 + (linkQ < 20 ? (20 - linkQ) / 20 : 0);
  }
  drawNoise(noise);
  $('scan').style.opacity = game.view === 'fpv' && settings.video === 'analog' && flying ? 0.55 : 0;
  glc.style.filter = game.view === 'fpv' && settings.video === 'analog' && flying ? 'saturate(0.75) contrast(1.12) blur(0.35px)' : '';
  if (game.view === 'fpv' && settings.video === 'digital' && linkQ < 8 && flying) glc.style.filter = 'blur(3px)';

  drawOSD(tel, linkQ);
  if (game.state !== 'start' && game.state !== 'boot') { drawMinimap(); drawBlackbox(); }
  else { mg.clearRect(0, 0, mm.width, mm.height); }
  const audible = flying || game.state === 'replay';
  const camDist = game.view === 'fpv' ? 0.4 : camera.position.distanceTo(new THREE.Vector3(pose.pos.x, pose.pos.y, pose.pos.z));
  sound.update(game.state === 'replay' ? { ...tel, motors: pose.m, speed: 0, vrs: 0 } : tel, camDist, audible);
}

// ======================================================================
// Inicialização
// ======================================================================
buildTerrain();
buildTrees();
buildStructures();
buildGates();
buildPads();
buildPitArea();
scenery = buildScenery(scene, world, { sunDir, sun, quality: settings.quality });
setTimeOfDay(settings.timeOfDay);
applySettingsToDrone();
setModel(settings.preset);
gimbalQ.setFromAxisAngle(new THREE.Vector3(1, 0, 0), gimbalPitch * D2R);
setupTouch();
resize();
$('minimap').hidden = !settings.showMap;
$('blackbox').hidden = !settings.showBlackbox;
$('loading').hidden = true;
applyHud();
showStart();
requestAnimationFrame(frame);

// Exposto para depuração no console.
window.fpv = { drone, world, settings, game };
