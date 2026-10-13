// Mundo do simulador: terreno, obstáculos, pista de corrida e alvos de pouso.
// Puro (sem three.js): usado tanto pela física quanto pela renderização.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function makeValueNoise(seed) {
  const rand = mulberry32(seed);
  const perm = new Uint16Array(512);
  const vals = new Float32Array(256);
  for (let i = 0; i < 256; i++) { perm[i] = i; vals[i] = rand(); }
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];
  const v = (x, y) => vals[perm[(x & 255) + perm[y & 255]]];
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    const u = fx * fx * (3 - 2 * fx), w = fy * fy * (3 - 2 * fy);
    const a = v(xi, yi), b = v(xi + 1, yi), c = v(xi, yi + 1), d = v(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * w + (a - b - c + d) * u * w;
  };
}

function fbm(noise, x, y, oct) {
  let sum = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += noise(x * f, y * f) * amp;
    norm += amp; amp *= 0.5; f *= 2.03;
  }
  return sum / norm;
}

// Traçado da pista (x, z, altura da base da abertura, largura, altura).
const TRACK = [
  [0, -22, 0.4, 2.4, 1.8],
  [28, -62, 0.4, 2.4, 1.8],
  [72, -84, 3.5, 2.4, 1.8],
  [112, -52, 0.4, 2.4, 1.8],
  [118, 8, 0.4, 2.4, 1.8],
  [88, 56, 6.0, 2.4, 1.8],
  [38, 80, 0.4, 2.4, 1.8],
  [-18, 62, 0.4, 2.4, 1.8],
  [-68, 76, 2.0, 2.4, 1.8],
  [-112, 32, 0.4, 2.4, 1.8],
  [-104, -30, 4.0, 2.4, 1.8],
  [-58, -58, 0.4, 2.4, 1.8],
];

// Prédios e containers (x, z, largura, profundidade, altura, yaw em graus, tipo).
const STRUCTURES = [
  [-175, -125, 34, 22, 12, 12, 'building'],
  [180, 118, 22, 42, 18, -8, 'building'],
  [150, -165, 11, 11, 46, 0, 'tower'],
  [-150, 150, 26, 26, 9, 30, 'building'],
  [-42, 22, 6.1, 2.44, 2.6, 0, 'container'],
  [-42, 25.2, 6.1, 2.44, 2.6, 0, 'container'],
  [-42, 23.6, 6.1, 2.44, 2.6, 90, 'container_top'],
  [52, 16, 6.1, 2.44, 2.6, 35, 'container'],
  [16, 34, 12.2, 2.44, 2.6, -20, 'container'],
];

export function createWorld(seed = 1337) {
  const rand = mulberry32(seed);
  const noise = makeValueNoise(seed);
  const FIELD_R = 150;

  // ---------- terreno em grade (a mesma grade gera a malha 3D) ----------
  const SIZE = 1400, SEGS = 280, CELL = SIZE / SEGS, HALF = SIZE / 2, N = SEGS + 1;
  const heights = new Float32Array(N * N);
  const rawHeight = (x, z) => {
    let h = (fbm(noise, x * 0.006 + 31.7, z * 0.006 - 12.1, 5) - 0.5) * 44;
    h += (fbm(noise, x * 0.03 + 100, z * 0.03 + 7, 2) - 0.5) * 3;
    const r = Math.hypot(x, z);
    if (r > 380) h += (r - 380) * 0.42 * (0.55 + 0.9 * fbm(noise, x * 0.01, z * 0.01, 3));
    return h;
  };
  for (let iz = 0; iz < N; iz++) {
    for (let ix = 0; ix < N; ix++) {
      const x = ix * CELL - HALF, z = iz * CELL - HALF;
      const f = smoothstep(FIELD_R, FIELD_R + 90, Math.hypot(x, z));
      heights[iz * N + ix] = rawHeight(x, z) * f;
    }
  }

  // Altura exata da malha (mesma triangulação usada na renderização).
  function heightAt(x, z) {
    const gx = (x + HALF) / CELL, gz = (z + HALF) / CELL;
    let ix = Math.floor(gx), iz = Math.floor(gz);
    if (ix < 0 || iz < 0 || ix >= SEGS || iz >= SEGS) return 0;
    const fx = gx - ix, fz = gz - iz;
    const a = heights[iz * N + ix], d = heights[iz * N + ix + 1];
    const b = heights[(iz + 1) * N + ix], c = heights[(iz + 1) * N + ix + 1];
    if (fx + fz <= 1) return a + (d - a) * fx + (b - a) * fz;
    return c + (b - c) * (1 - fx) + (d - c) * (1 - fz);
  }

  function normalAt(x, z) {
    const e = 0.5;
    const dx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
    const dz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
    const l = Math.hypot(dx, 1, dz);
    return { x: -dx / l, y: 1 / l, z: -dz / l };
  }

  const colliders = [];
  const addBox = (cx, cy, cz, hx, hy, hz, yawDeg, kind) => {
    const yaw = (yawDeg * Math.PI) / 180;
    colliders.push({ type: 'box', cx, cy, cz, hx, hy, hz, yaw, cos: Math.cos(yaw), sin: Math.sin(yaw), kind });
  };
  const addCyl = (x, z, r, y0, y1, kind) => colliders.push({ type: 'cyl', x, z, r, y0, y1, kind });

  // ---------- pista ----------
  const gates = TRACK.map(([x, z, yb, w, h], i) => {
    const prev = TRACK[(i - 1 + TRACK.length) % TRACK.length];
    const next = TRACK[(i + 1) % TRACK.length];
    let dx = next[0] - prev[0], dz = next[1] - prev[1];
    const l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;
    const yaw = Math.atan2(-dx, -dz);
    const ground = heightAt(x, z);
    return {
      index: i, x, z, w, h, yaw, ground, yb,
      cy: ground + yb + h / 2,
      normal: { x: dx, y: 0, z: dz },
      right: { x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) },
      thick: 0.14,
    };
  });
  for (const g of gates) {
    const t = g.thick, yawDeg = (g.yaw * 180) / Math.PI;
    const topY = g.ground + g.yb + g.h;
    const off = g.w / 2 + t / 2;
    for (const s of [-1, 1]) {
      const px = g.x + g.right.x * off * s, pz = g.z + g.right.z * off * s;
      addBox(px, (g.ground + topY + t) / 2, pz, t / 2, (topY + t - g.ground) / 2, t / 2, yawDeg, 'gate');
    }
    addBox(g.x, topY + t / 2, g.z, off + t / 2, t / 2, t / 2, yawDeg, 'gate');
    if (g.yb > 0.3) addBox(g.x, g.ground + g.yb - t / 2, g.z, off + t / 2, t / 2, t / 2, yawDeg, 'gate');
  }

  // ---------- estruturas ----------
  const structures = [];
  for (const [x, z, w, d, h, yawDeg, kind] of STRUCTURES) {
    let base;
    if (kind === 'container_top') {
      base = 2.6;
    } else {
      const yaw = (yawDeg * Math.PI) / 180;
      const c = Math.cos(yaw), s = Math.sin(yaw);
      base = Infinity;
      for (const [lx, lz] of [[-w / 2, -d / 2], [w / 2, -d / 2], [-w / 2, d / 2], [w / 2, d / 2], [0, 0]]) {
        base = Math.min(base, heightAt(x + lx * c + lz * s, z - lx * s + lz * c));
      }
      base -= 0.6;
    }
    const top = (kind === 'container_top' ? base : Math.max(base, heightAt(x, z))) + h;
    structures.push({ x, z, w, d, h, base, top, yaw: (yawDeg * Math.PI) / 180, kind: kind.replace('_top', '') });
    addBox(x, (base + top) / 2, z, w / 2, (top - base) / 2, d / 2, yawDeg, kind.startsWith('container') ? 'container' : 'building');
  }

  // ---------- pontos de pouso ----------
  const pads = [
    { x: 0, z: 0, y: 0, r: 1.2, label: 'H' },
    { x: 34, z: 28, y: 0, r: 1.0, label: '1' },
    { x: -42, z: 23.6, y: 5.2, r: 0.9, label: '2' },
    { x: -88, z: -6, y: 0, r: 1.0, label: '3' },
    { x: 18, z: -112, y: 0, r: 1.0, label: '4' },
    { x: 150, z: -165, y: 0, r: 1.6, label: '5' },
  ];
  pads[5].y = structures.find((s) => s.kind === 'tower').top;

  // ---------- árvores ----------
  const segDist = (px, pz, ax, az, bx, bz) => {
    const vx = bx - ax, vz = bz - az;
    const t = Math.max(0, Math.min(1, ((px - ax) * vx + (pz - az) * vz) / (vx * vx + vz * vz)));
    return Math.hypot(px - ax - vx * t, pz - az - vz * t);
  };
  const nearTrack = (x, z, m) => {
    for (let i = 0; i < gates.length; i++) {
      const a = gates[i], b = gates[(i + 1) % gates.length];
      if (segDist(x, z, a.x, a.z, b.x, b.z) < m) return true;
    }
    return false;
  };
  const nearStructure = (x, z, m) => structures.some((s) => Math.hypot(x - s.x, z - s.z) < Math.max(s.w, s.d) * 0.75 + m);
  const nearPad = (x, z, m) => pads.some((p) => Math.hypot(x - p.x, z - p.z) < m);

  const trees = [];
  let guard = 0;
  while (trees.length < 520 && guard++ < 20000) {
    const ang = rand() * Math.PI * 2;
    const r = 35 + Math.pow(rand(), 0.7) * 470;
    const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
    if (Math.abs(x) > HALF - 30 || Math.abs(z) > HALF - 30) continue;
    // Bosques: densidade guiada por ruído.
    if (fbm(noise, x * 0.012 + 50, z * 0.012 - 80, 3) < 0.47 && r > 60) continue;
    if (nearTrack(x, z, 9) || nearStructure(x, z, 6) || nearPad(x, z, 12)) continue;
    if (trees.some((t) => Math.abs(t.x - x) < 3 && Math.abs(t.z - z) < 3)) continue;
    const h = 7 + rand() * 9;
    const crown = h * (0.22 + rand() * 0.08);
    const y = heightAt(x, z);
    const kind = rand() < 0.68 ? 'pine' : 'round';
    trees.push({ x, z, y, h, crown, kind, hue: rand() });
    addCyl(x, z, 0.28, y - 1, y + h * 0.4, 'tree');
    addCyl(x, z, crown * 0.75, y + h * 0.3, y + h * 0.97, 'tree');
  }

  // ---------- broadphase em grade uniforme ----------
  const GCELL = 16;
  const grid = new Map();
  const key = (i, j) => i * 100003 + j;
  colliders.forEach((c, idx) => {
    let x0, x1, z0, z1;
    if (c.type === 'box') {
      const ext = Math.abs(c.hx * c.cos) + Math.abs(c.hz * c.sin);
      const ezt = Math.abs(c.hx * c.sin) + Math.abs(c.hz * c.cos);
      x0 = c.cx - ext; x1 = c.cx + ext; z0 = c.cz - ezt; z1 = c.cz + ezt;
    } else { x0 = c.x - c.r; x1 = c.x + c.r; z0 = c.z - c.r; z1 = c.z + c.r; }
    for (let i = Math.floor((x0 - 1) / GCELL); i <= Math.floor((x1 + 1) / GCELL); i++) {
      for (let j = Math.floor((z0 - 1) / GCELL); j <= Math.floor((z1 + 1) / GCELL); j++) {
        const k = key(i, j);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(idx);
      }
    }
  });

  // Esfera (centro p, raio r) contra o mundo. Devolve o contato mais profundo.
  function collideSphere(px, py, pz, r, skipGround = false) {
    let best = null;
    const gh = heightAt(px, pz);
    if (!skipGround && py - r < gh + 0.5) {
      const n = normalAt(px, pz);
      const pen = r - (py - gh) * n.y;
      if (pen > 0) best = { pen, nx: n.x, ny: n.y, nz: n.z, kind: 'ground' };
    }
    const list = grid.get(key(Math.floor(px / GCELL), Math.floor(pz / GCELL)));
    if (!list) return best;
    for (const idx of list) {
      const c = colliders[idx];
      let pen = 0, nx = 0, ny = 0, nz = 0;
      if (c.type === 'box') {
        const dx = px - c.cx, dy = py - c.cy, dz = pz - c.cz;
        const lx = dx * c.cos - dz * c.sin, ly = dy, lz = dx * c.sin + dz * c.cos;
        if (Math.abs(lx) > c.hx + r || Math.abs(ly) > c.hy + r || Math.abs(lz) > c.hz + r) continue;
        const qx = Math.max(-c.hx, Math.min(c.hx, lx));
        const qy = Math.max(-c.hy, Math.min(c.hy, ly));
        const qz = Math.max(-c.hz, Math.min(c.hz, lz));
        let ex = lx - qx, ey = ly - qy, ez = lz - qz;
        const d = Math.hypot(ex, ey, ez);
        if (d > 1e-6) {
          if (d >= r) continue;
          pen = r - d; ex /= d; ey /= d; ez /= d;
        } else {
          const fx = c.hx - Math.abs(lx), fy = c.hy - Math.abs(ly), fz = c.hz - Math.abs(lz);
          ex = ey = ez = 0;
          if (fx <= fy && fx <= fz) { ex = Math.sign(lx) || 1; pen = r + fx; }
          else if (fy <= fz) { ey = Math.sign(ly) || 1; pen = r + fy; }
          else { ez = Math.sign(lz) || 1; pen = r + fz; }
        }
        nx = ex * c.cos + ez * c.sin; ny = ey; nz = -ex * c.sin + ez * c.cos;
      } else {
        if (py + r < c.y0 || py - r > c.y1) continue;
        const dx = px - c.x, dz = pz - c.z;
        const dh = Math.hypot(dx, dz);
        if (dh > c.r + r) continue;
        if (py > c.y1 && dh < c.r) { pen = r - (py - c.y1); nx = 0; ny = 1; nz = 0; }
        else {
          pen = c.r + r - dh;
          const s = dh > 1e-6 ? 1 / dh : 0;
          nx = dx * s || 1; ny = 0; nz = dz * s;
        }
        if (pen <= 0) continue;
      }
      if (!best || pen > best.pen) best = { pen, nx, ny, nz, kind: c.kind };
    }
    return best;
  }

  // Cruzamento de portal: segmento p0→p1 atravessando o plano no sentido da pista.
  function gateCrossed(g, p0, p1) {
    const d0 = (p0.x - g.x) * g.normal.x + (p0.z - g.z) * g.normal.z;
    const d1 = (p1.x - g.x) * g.normal.x + (p1.z - g.z) * g.normal.z;
    if (!(d0 < 0 && d1 >= 0)) return false;
    const t = d0 / (d0 - d1);
    const ix = p0.x + (p1.x - p0.x) * t, iy = p0.y + (p1.y - p0.y) * t, iz = p0.z + (p1.z - p0.z) * t;
    const lat = (ix - g.x) * g.right.x + (iz - g.z) * g.right.z;
    return Math.abs(lat) <= g.w / 2 && Math.abs(iy - g.cy) <= g.h / 2;
  }

  // Linha de visada piloto→drone livre de terreno/prédios (para o sinal de vídeo).
  function lineOfSight(a, b) {
    const steps = 24;
    let blocked = 0;
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t, z = a.z + (b.z - a.z) * t;
      if (heightAt(x, z) > y) blocked += 1;
      else {
        const hit = collideSphere(x, y, z, 0.01);
        if (hit && hit.kind !== 'ground' && hit.kind !== 'gate') blocked += 0.5;
      }
    }
    return Math.min(1, blocked / 4);
  }

  return {
    seed, SIZE, SEGS, CELL, HALF, N, heights, FIELD_R,
    heightAt, normalAt, collideSphere, gateCrossed, lineOfSight,
    gates, structures, pads, trees, colliders,
    spawn: { x: 0, z: 0, yaw: 0 },
    pilot: { x: 0, y: 1.7, z: 7 },
  };
}
