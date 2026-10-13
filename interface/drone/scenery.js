// Cenário detalhado: cidade, ruas, postes, lago com reflexo, nuvens, grama e reflexo do sol na lente.
import * as THREE from 'three';
import { Water } from 'three/addons/objects/Water.js';
import { mulberry32 } from './world.js';

const rnd = mulberry32(4242);

function canvas(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  return c;
}
function tex(c, srgb = true) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

// ---------- fachadas ----------
// Cada textura representa um módulo de fachada de TILE_W × TILE_H metros (4 andares).
const TILE_W = 12, TILE_H = 14;
const FLOORS = 4;

function facade(style) {
  const W = 512, H = 512, fh = H / FLOORS;
  const lit = [];
  const color = canvas(W, H, (g) => {
    const base = { glass: '#5d7486', office: '#b9b4aa', residential: '#e4dccb', brick: '#9a5a44' }[style];
    g.fillStyle = base; g.fillRect(0, 0, W, H);
    for (let i = 0; i < 3500; i++) { g.fillStyle = `rgba(0,0,0,${rnd() * 0.05})`; g.fillRect(rnd() * W, rnd() * H, 2, 2); }
    if (style === 'brick') {
      for (let y = 0; y < H; y += 6) {
        for (let x = (y / 6) % 2 ? 0 : 7; x < W; x += 14) { g.fillStyle = `rgba(${60 + rnd() * 40},${20 + rnd() * 20},10,${0.15 + rnd() * 0.2})`; g.fillRect(x, y, 13, 5); }
      }
    }
    for (let f = 0; f < FLOORS; f++) {
      const y0 = f * fh;
      if (style === 'glass') {
        for (let c = 0; c < 8; c++) {
          const v = 70 + rnd() * 40;
          g.fillStyle = `rgb(${v * 0.75},${v * 0.92},${v * 1.1})`;
          g.fillRect(c * 64 + 3, y0 + 6, 58, fh - 12);
          lit.push([c * 64 + 3, y0 + 6, 58, fh - 12]);
        }
        g.fillStyle = '#2b3036'; g.fillRect(0, y0, W, 6);
      } else if (style === 'office') {
        g.fillStyle = '#323c46'; g.fillRect(0, y0 + fh * 0.32, W, fh * 0.5);
        for (let c = 0; c < 16; c++) { g.fillStyle = '#8f8a80'; g.fillRect(c * 32, y0 + fh * 0.32, 3, fh * 0.5); lit.push([c * 32 + 3, y0 + fh * 0.32, 29, fh * 0.5]); }
      } else {
        for (let c = 0; c < 4; c++) {
          const x = c * 128 + 34;
          g.fillStyle = '#3b4650'; g.fillRect(x, y0 + 28, 60, 70);
          g.fillStyle = 'rgba(255,255,255,0.18)'; g.fillRect(x, y0 + 28, 60, 8);
          g.fillStyle = style === 'brick' ? '#d8cfc0' : '#a9a294'; g.fillRect(x - 4, y0 + 98, 68, 6);
          lit.push([x, y0 + 28, 60, 70]);
          if (style === 'residential' && f % 2 === 0) { g.strokeStyle = '#555'; g.lineWidth = 3; g.strokeRect(x - 8, y0 + 70, 76, 34); }
        }
      }
    }
  });
  const emissive = canvas(W, H, (g) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    for (const [x, y, w, h] of lit) {
      if (rnd() < 0.38) { const k = 160 + rnd() * 95; g.fillStyle = `rgb(${k},${k * 0.82},${k * 0.55})`; g.fillRect(x, y, w, h); }
    }
  });
  const mat = new THREE.MeshStandardMaterial({
    map: tex(color), emissiveMap: tex(emissive), emissive: 0xffffff, emissiveIntensity: 0,
    roughness: style === 'glass' ? 0.12 : style === 'office' ? 0.55 : 0.85,
    metalness: style === 'glass' ? 0.85 : 0.05, vertexColors: true,
  });
  return mat;
}

function quadBuilder() {
  const pos = [], nor = [], uv = [], col = [], idx = [];
  return {
    quad(p, n, u, c) {
      const b = pos.length / 3;
      for (let i = 0; i < 4; i++) { pos.push(...p[i]); nor.push(...n); uv.push(...u[i]); col.push(c.r, c.g, c.b); }
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    },
    build() {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.setIndex(idx);
      return g;
    },
  };
}

function buildTown(scene, world) {
  const styles = ['glass', 'office', 'residential', 'brick'];
  const mats = Object.fromEntries(styles.map((s) => [s, facade(s)]));
  const qb = Object.fromEntries(styles.map((s) => [s, quadBuilder()]));
  const roof = quadBuilder();
  const tints = {
    glass: ['#ffffff', '#cfe0ff', '#d9f0e8'], office: ['#ffffff', '#e8e2d6', '#d6dde4'],
    residential: ['#ffffff', '#f3d9c4', '#d9e6f3', '#e9e3b8', '#f0c9c9'], brick: ['#ffffff', '#e0c8b8', '#c9a993'],
  };
  const c = new THREE.Color();
  for (const b of world.town) {
    if (b.style === 'park') continue;
    const x0 = b.x - b.w / 2, x1 = b.x + b.w / 2, z0 = b.z - b.d / 2, z1 = b.z + b.d / 2, h = b.h, y0 = -0.3;
    c.set(tints[b.style][Math.floor(rnd() * tints[b.style].length)]);
    const q = qb[b.style];
    const off = rnd();
    const U = (m) => m / TILE_W + off, V = (m) => m / TILE_H;
    q.quad([[x0, y0, z1], [x1, y0, z1], [x1, h, z1], [x0, h, z1]], [0, 0, 1], [[U(0), 0], [U(b.w), 0], [U(b.w), V(h)], [U(0), V(h)]], c);
    q.quad([[x1, y0, z0], [x0, y0, z0], [x0, h, z0], [x1, h, z0]], [0, 0, -1], [[U(0), 0], [U(b.w), 0], [U(b.w), V(h)], [U(0), V(h)]], c);
    q.quad([[x1, y0, z1], [x1, y0, z0], [x1, h, z0], [x1, h, z1]], [1, 0, 0], [[U(0), 0], [U(b.d), 0], [U(b.d), V(h)], [U(0), V(h)]], c);
    q.quad([[x0, y0, z0], [x0, y0, z1], [x0, h, z1], [x0, h, z0]], [-1, 0, 0], [[U(0), 0], [U(b.d), 0], [U(b.d), V(h)], [U(0), V(h)]], c);
    const g = 0.35 + rnd() * 0.15;
    roof.quad([[x0, h, z1], [x1, h, z1], [x1, h, z0], [x0, h, z0]], [0, 1, 0], [[x0 / 8, z1 / 8], [x1 / 8, z1 / 8], [x1 / 8, z0 / 8], [x0 / 8, z0 / 8]], new THREE.Color(g, g, g));
  }
  for (const s of styles) {
    const m = new THREE.Mesh(qb[s].build(), mats[s]);
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
  }
  const roofTex = tex(canvas(128, 128, (g, w, h) => {
    g.fillStyle = '#8a8a86'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 900; i++) { g.fillStyle = `rgba(0,0,0,${rnd() * 0.12})`; g.fillRect(rnd() * w, rnd() * h, 2, 2); }
  }));
  const roofMesh = new THREE.Mesh(roof.build(), new THREE.MeshStandardMaterial({ map: roofTex, vertexColors: true, roughness: 0.9 }));
  roofMesh.receiveShadow = true; roofMesh.castShadow = true;
  scene.add(roofMesh);

  // Equipamentos no telhado (caixas de ar-condicionado e caixas d'água).
  const units = world.town.filter((b) => b.style !== 'park');
  const box = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x9a9d9f, roughness: 0.6, metalness: 0.4 }), units.length * 3);
  const m4 = new THREE.Matrix4();
  let k = 0;
  for (const b of units) {
    for (let i = 0; i < 3; i++) {
      const sx = 1.5 + rnd() * 2.5, sy = 1 + rnd() * 1.6, sz = 1.5 + rnd() * 2.5;
      m4.compose(new THREE.Vector3(b.x + (rnd() - 0.5) * (b.w - 5), b.h + sy / 2, b.z + (rnd() - 0.5) * (b.d - 5)), new THREE.Quaternion(), new THREE.Vector3(sx, sy, sz));
      box.setMatrixAt(k++, m4);
    }
  }
  box.castShadow = true;
  scene.add(box);

  // Ruas com faixa tracejada, calçadas e parque.
  const asphalt = canvas(512, 256, (g, w, h) => {
    g.fillStyle = '#3a3c3f'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 9000; i++) { const v = 40 + rnd() * 40; g.fillStyle = `rgba(${v},${v},${v + 3},0.6)`; g.fillRect(rnd() * w, rnd() * h, 2, 2); }
    g.fillStyle = '#d9c25a';
    for (let x = 0; x < w; x += 64) g.fillRect(x, h / 2 - 3, 36, 6);
    g.fillStyle = 'rgba(240,240,240,0.85)'; g.fillRect(0, 10, w, 4); g.fillRect(0, h - 14, w, 4);
  });
  const roadTex = tex(asphalt);
  const rq = quadBuilder();
  const white = new THREE.Color(1, 1, 1);
  for (const r of world.roads) {
    const x0 = r.x - r.w / 2, x1 = r.x + r.w / 2, z0 = r.z - r.d / 2, z1 = r.z + r.d / 2, y = 0.03;
    if (r.axis === 'x') rq.quad([[x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0]], [0, 1, 0], [[x0 / 18, 0], [x1 / 18, 0], [x1 / 18, 1], [x0 / 18, 1]], white);
    else rq.quad([[x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0]], [0, 1, 0], [[z1 / 18, 0], [z1 / 18, 1], [z0 / 18, 1], [z0 / 18, 0]], white);
  }
  const roads = new THREE.Mesh(rq.build(), new THREE.MeshStandardMaterial({ map: roadTex, roughness: 0.92, polygonOffset: true, polygonOffsetFactor: -3 }));
  roads.receiveShadow = true;
  scene.add(roads);

  const T = world.TOWN;
  const sidewalkTex = tex(canvas(128, 128, (g, w, h) => {
    g.fillStyle = '#a7a39b'; g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(0,0,0,0.18)'; g.lineWidth = 2;
    for (let i = 0; i <= w; i += 32) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, h); g.moveTo(0, i); g.lineTo(w, i); g.stroke(); }
  }));
  sidewalkTex.repeat.set((T.x1 - T.x0) / 2, (T.z1 - T.z0) / 2);
  const walk = new THREE.Mesh(new THREE.PlaneGeometry(T.x1 - T.x0 + 10, T.z1 - T.z0 + 10).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: sidewalkTex, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2 }));
  walk.position.set((T.x0 + T.x1) / 2, 0.02, (T.z0 + T.z1) / 2);
  walk.receiveShadow = true;
  scene.add(walk);
  for (const pk of world.town.filter((b) => b.style === 'park')) {
    const grass = new THREE.Mesh(new THREE.PlaneGeometry(pk.w, pk.d).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x4f7a34, roughness: 1, polygonOffset: true, polygonOffsetFactor: -4 }));
    grass.position.set(pk.x, 0.04, pk.z);
    grass.receiveShadow = true;
    scene.add(grass);
  }

  // Postes com lâmpadas que acendem à noite.
  const L = world.lamps;
  const poleGeo = new THREE.CylinderGeometry(0.08, 0.12, 7, 6).translate(0, 3.5, 0);
  const armGeo = new THREE.BoxGeometry(1.6, 0.08, 0.08).translate(0.8, 7, 0);
  const bulbGeo = new THREE.BoxGeometry(0.5, 0.12, 0.25).translate(1.5, 6.92, 0);
  const metal = new THREE.MeshStandardMaterial({ color: 0x4a4f55, metalness: 0.6, roughness: 0.4 });
  const bulbMat = new THREE.MeshStandardMaterial({ color: 0xfff2d0, emissive: 0xffd9a0, emissiveIntensity: 0 });
  const poles = new THREE.InstancedMesh(poleGeo, metal, L.length);
  const arms = new THREE.InstancedMesh(armGeo, metal, L.length);
  const bulbs = new THREE.InstancedMesh(bulbGeo, bulbMat, L.length);
  L.forEach((l, i) => {
    m4.compose(new THREE.Vector3(l.x, 0, l.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (i % 4) * (Math.PI / 2)), new THREE.Vector3(1, 1, 1));
    poles.setMatrixAt(i, m4); arms.setMatrixAt(i, m4); bulbs.setMatrixAt(i, m4);
  });
  poles.castShadow = arms.castShadow = true;
  scene.add(poles, arms, bulbs);

  return {
    setNight(n) {
      for (const s of styles) mats[s].emissiveIntensity = n * 1.6;
      bulbMat.emissiveIntensity = n * 6;
    },
  };
}

// ---------- lago ----------
function waterNormals() {
  const S = 256;
  const c = canvas(S, S, (g) => {
    const img = g.createImageData(S, S);
    const waves = Array.from({ length: 14 }, () => ({ kx: Math.round((rnd() - 0.5) * 16), ky: Math.round((rnd() - 0.5) * 16), a: 0.3 + rnd(), p: rnd() * 6.28 }));
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        let dx = 0, dy = 0;
        for (const w of waves) {
          const ph = ((w.kx * x + w.ky * y) / S) * Math.PI * 2 + w.p;
          const c2 = Math.cos(ph) * w.a;
          dx += c2 * w.kx; dy += c2 * w.ky;
        }
        const n = new THREE.Vector3(-dx * 0.02, -dy * 0.02, 1).normalize();
        const o = (y * S + x) * 4;
        img.data[o] = (n.x * 0.5 + 0.5) * 255; img.data[o + 1] = (n.y * 0.5 + 0.5) * 255; img.data[o + 2] = (n.z * 0.5 + 0.5) * 255; img.data[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  });
  return tex(c, false);
}

function buildWater(scene, world, sunDir, reflections) {
  const geo = new THREE.CircleGeometry(world.LAKE.r * 1.35, 64);
  let water;
  if (reflections) {
    water = new Water(geo, {
      textureWidth: 512, textureHeight: 512, waterNormals: waterNormals(), sunDirection: sunDir.clone(),
      sunColor: 0xffffff, waterColor: 0x0d2b36, distortionScale: 2.2, fog: true,
    });
    water.material.uniforms.size.value = 6;
  } else {
    water = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x1d4250, roughness: 0.08, metalness: 0.7 }));
  }
  water.rotation.x = -Math.PI / 2;
  water.position.set(world.LAKE.x, world.WATER_Y, world.LAKE.z);
  scene.add(water);
  return {
    mesh: water,
    update(dt, sun) {
      if (!reflections) return;
      water.material.uniforms.time.value += dt * 0.6;
      water.material.uniforms.sunDirection.value.copy(sun);
    },
  };
}

// ---------- nuvens ----------
function buildClouds(scene) {
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
    uniforms: { time: { value: 0 }, sun: { value: new THREE.Vector3(0, 1, 0) }, day: { value: 1 }, cover: { value: 0.45 } },
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec2 vUv; varying vec3 vW;
      void main() {
        vUv = uv;
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform float time; uniform vec3 sun; uniform float day; uniform float cover;
      varying vec2 vUv; varying vec3 vW;
      float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float n(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
      float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 6; i++) { s += n(p) * a; p *= 2.03; a *= 0.5; } return s; }
      void main() {
        #include <logdepthbuf_fragment>
        vec2 p = vW.xz * 0.0011 + vec2(time * 0.004, time * 0.0015);
        float d = fbm(p);
        float c = smoothstep(cover, cover + 0.28, d);
        float edge = 1.0 - smoothstep(0.30, 0.5, length(vUv - 0.5));
        float shade = 0.75 + 0.25 * smoothstep(cover, cover + 0.5, fbm(p + sun.xz * 0.02));
        vec3 lit = mix(vec3(1.0, 0.72, 0.55), vec3(1.0), clamp(sun.y * 3.0, 0.0, 1.0));
        vec3 col = lit * shade * mix(0.18, 1.0, day);
        gl_FragColor = vec4(col, c * edge * 0.92);
      }`,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000).rotateX(-Math.PI / 2), mat);
  m.position.y = 950;
  m.renderOrder = -1;
  scene.add(m);
  return {
    update(dt, sun, day, wind) {
      mat.uniforms.time.value += dt * (1 + wind * 0.4);
      mat.uniforms.sun.value.copy(sun);
      mat.uniforms.day.value = day;
    },
  };
}

// ---------- grama ----------
function buildGrass(scene, world, count) {
  const blade = new THREE.BufferGeometry();
  blade.setAttribute('position', new THREE.Float32BufferAttribute([-0.03, 0, 0, 0.03, 0, 0, 0.005, 1, 0.02, -0.03, 0, 0, 0.005, 1, 0.02, 0, 0, 0.03], 3));
  blade.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, side: THREE.DoubleSide, roughness: 0.95 });
  const uniforms = { time: { value: 0 } };
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.time = uniforms.time;
    sh.vertexShader = 'uniform float time;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      vec4 ip = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
      float sway = sin(time * 1.7 + ip.x * 0.35 + ip.z * 0.27) * 0.09 + sin(time * 3.1 + ip.x) * 0.03;
      transformed.x += sway * position.y; transformed.z += sway * 0.6 * position.y;`);
  };
  const im = new THREE.InstancedMesh(blade, mat, count);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), c = new THREE.Color();
  const up = new THREE.Vector3(0, 1, 0);
  let k = 0;
  while (k < count) {
    const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * (world.FIELD_R - 6);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (world.pads.some((p) => Math.hypot(x - p.x, z - p.z) < p.r + 0.3)) continue;
    q.setFromAxisAngle(up, rnd() * 6.28);
    const hgt = 0.08 + rnd() * 0.16;
    m4.compose(new THREE.Vector3(x, 0, z), q, new THREE.Vector3(1.5 + rnd() * 1.5, hgt, 1.5));
    im.setMatrixAt(k, m4);
    c.setHSL(0.24 + rnd() * 0.06, 0.4 + rnd() * 0.2, 0.12 + rnd() * 0.09);
    im.setColorAt(k, c);
    k++;
  }
  im.receiveShadow = true;
  im.frustumCulled = false;
  scene.add(im);
  return { update(dt) { uniforms.time.value += dt; } };
}

export function buildScenery(scene, world, { sunDir, sun, quality }) {
  const hi = quality === 'high' || quality === 'ultra';
  const town = buildTown(scene, world);
  const water = buildWater(scene, world, sunDir, quality !== 'low');
  const clouds = buildClouds(scene);
  const grass = hi ? buildGrass(scene, world, quality === 'ultra' ? 90000 : 45000) : null;
  return {
    update(dt, { day, wind }) {
      water.update(dt, sunDir);
      clouds.update(dt, sunDir, day, wind);
      grass?.update(dt);
    },
    setNight: (n) => town.setNight(n),
    water: water.mesh,
  };
}
