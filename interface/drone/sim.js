// Núcleo do simulador: dinâmica de corpo rígido, motores, bateria, aerodinâmica
// e controladora de voo (PID em cascata no estilo Betaflight).
// Unidades SI. Frame do corpo: +X direita, +Y cima, -Z frente (mesma convenção do three.js).

export const G = 9.81;
export const RHO = 1.225;
const D2R = Math.PI / 180;

// ---------- matemática ----------
export const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const scl = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const len = (a) => Math.hypot(a.x, a.y, a.z);
const norm = (a) => { const l = len(a) || 1; return { x: a.x / l, y: a.y / l, z: a.z / l }; };
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

export const Q = {
  ident: () => ({ x: 0, y: 0, z: 0, w: 1 }),
  mul: (a, b) => ({
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  }),
  conj: (q) => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w }),
  rot(q, v) {
    const ix = q.w * v.x + q.y * v.z - q.z * v.y;
    const iy = q.w * v.y + q.z * v.x - q.x * v.z;
    const iz = q.w * v.z + q.x * v.y - q.y * v.x;
    const iw = -q.x * v.x - q.y * v.y - q.z * v.z;
    return {
      x: ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
      y: iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
      z: iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
    };
  },
  invRot: (q, v) => Q.rot(Q.conj(q), v),
  axisAngle(ax, ang) { const s = Math.sin(ang / 2); return { x: ax.x * s, y: ax.y * s, z: ax.z * s, w: Math.cos(ang / 2) }; },
  normalize(q) { const l = Math.hypot(q.x, q.y, q.z, q.w) || 1; return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l }; },
};

// Rates "Betaflight" (RC Rate, Super Rate, Expo) → graus/s.
export function rateDps(stick, r) {
  const x = clamp(stick, -1, 1);
  const ax = Math.abs(x);
  const rc = r.expo ? x * ax * ax * ax * r.expo + x * (1 - r.expo) : x;
  let rate = 200 * r.rcRate * rc;
  if (r.superRate) rate *= 1 / clamp(1 - Math.abs(rc) * r.superRate, 0.01, 1);
  return clamp(rate, -1998, 1998);
}

const ocvTable = [[0, 3.0], [0.05, 3.45], [0.1, 3.6], [0.2, 3.68], [0.4, 3.75], [0.6, 3.86], [0.8, 4.0], [1, 4.2]];
export function cellOcv(soc) {
  soc = clamp(soc, 0, 1);
  for (let i = 1; i < ocvTable.length; i++) {
    const [s1, v1] = ocvTable[i];
    if (soc <= s1) { const [s0, v0] = ocvTable[i - 1]; return v0 + ((v1 - v0) * (soc - s0)) / (s1 - s0); }
  }
  return 4.2;
}

// ---------- presets de aeronaves ----------
// arm = distância do motor ao centro em X e em Z (quad em X); tmax = empuxo estático por motor (N)
// a 3,8 V/célula; rpm = rotação máxima carregada; tau = constante de tempo do motor (s);
// qt = razão torque/empuxo da hélice (m); cda = área×Cd por eixo do corpo [lado, topo, frente].
export const PRESETS = {
  racer: {
    name: 'Freestyle 5"', short: '5" FREESTYLE', desc: '6S · 650 g · empuxo/peso ≈ 10:1',
    mass: 0.65, arm: 0.08, inertia: [0.0024, 0.0042, 0.0021],
    tmax: 16, rpm: 34000, tau: 0.022, qt: 0.014, propR: 0.0635, pitch: 0.109,
    cells: 6, capacity: 1300, rint: 0.035, eff: 0.38, cda: [0.012, 0.03, 0.012], rotorDrag: 0.12,
    crash: 9, camTilt: 30, fov: 118, mode: 'acro', maxAngle: 55, scale: 1,
    rates: { roll: { rcRate: 1.0, superRate: 0.7, expo: 0.0 }, pitch: { rcRate: 1.0, superRate: 0.7, expo: 0.0 }, yaw: { rcRate: 1.0, superRate: 0.65, expo: 0.0 } },
  },
  cinewhoop: {
    name: 'Cinewhoop 3"', short: 'CINEWHOOP 3"', desc: '4S · 380 g · dutos de proteção',
    mass: 0.38, arm: 0.055, inertia: [0.0009, 0.0016, 0.0008],
    tmax: 5.4, rpm: 27000, tau: 0.03, qt: 0.012, propR: 0.038, pitch: 0.075,
    cells: 4, capacity: 850, rint: 0.05, eff: 0.3, cda: [0.014, 0.036, 0.014], rotorDrag: 0.2,
    crash: 11, camTilt: 12, fov: 110, mode: 'angle', maxAngle: 45, scale: 0.75,
    rates: { roll: { rcRate: 0.9, superRate: 0.6, expo: 0.2 }, pitch: { rcRate: 0.9, superRate: 0.6, expo: 0.2 }, yaw: { rcRate: 0.9, superRate: 0.5, expo: 0.2 } },
  },
  camera: {
    name: 'Câmera (estilo DJI)', short: 'CAM DRONE', desc: '3S · 900 g · gimbal + GPS',
    mass: 0.9, arm: 0.125, inertia: [0.0075, 0.013, 0.0068],
    tmax: 5.6, rpm: 10500, tau: 0.055, qt: 0.02, propR: 0.114, pitch: 0.11,
    cells: 3, capacity: 4000, rint: 0.04, eff: 0.45, cda: [0.02, 0.05, 0.02], rotorDrag: 0.25,
    crash: 4, camTilt: 0, fov: 84, mode: 'pos', maxAngle: 35, scale: 1.35, gimbal: true,
    maxSpeed: 16, maxClimb: 5, maxDescent: 3.5,
    rates: { roll: { rcRate: 0.7, superRate: 0.3, expo: 0.3 }, pitch: { rcRate: 0.7, superRate: 0.3, expo: 0.3 }, yaw: { rcRate: 0.6, superRate: 0.2, expo: 0.3 } },
  },
  whoop: {
    name: 'Tiny Whoop 65 mm', short: 'TINY WHOOP', desc: '1S · 32 g · para voar perto de tudo',
    mass: 0.032, arm: 0.023, inertia: [0.000013, 0.000021, 0.000012],
    tmax: 0.25, rpm: 50000, tau: 0.02, qt: 0.006, propR: 0.0155, pitch: 0.022,
    cells: 1, capacity: 300, rint: 0.15, eff: 0.15, cda: [0.0016, 0.0042, 0.0016], rotorDrag: 0.006,
    crash: 12, camTilt: 15, fov: 110, mode: 'angle', maxAngle: 50, scale: 0.32,
    rates: { roll: { rcRate: 1.0, superRate: 0.6, expo: 0.1 }, pitch: { rcRate: 1.0, superRate: 0.6, expo: 0.1 }, yaw: { rcRate: 1.0, superRate: 0.5, expo: 0.1 } },
  },
};

// Ordem dos motores (Betaflight): 0 traseiro-dir, 1 frontal-dir, 2 traseiro-esq, 3 frontal-esq.
const MOTOR_POS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const SPIN = [-1, 1, 1, -1]; // +1 = anti-horário visto de cima
const MIX_ROLL = [-1, -1, 1, 1];
const MIX_PITCH = [1, -1, 1, -1];

export const MODES = { acro: 'ACRO', angle: 'ANGLE', pos: 'GPS' };

export class Drone {
  constructor(world, presetKey = 'racer') {
    this.world = world;
    this.cfg = {
      mode: null,
      rates: null,
      maxAngle: null,
      wind: { speed: 0, dir: 45, gust: 0.3 },
      propWash: true,
      groundEffect: true,
      battery: true, // false = bateria infinita
      cine: false, // modo Cine: velocidades baixas e movimentos suaves (só no modo GPS)
      gyroNoise: true,
    };
    this.listeners = {};
    this.setPreset(presetKey);
    this.reset();
  }

  on(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
  emit(ev, data) { (this.listeners[ev] || []).forEach((fn) => fn(data)); }

  setPreset(key) {
    const p = PRESETS[key];
    this.presetKey = key;
    this.p = p;
    const omegaMax = (p.rpm * 2 * Math.PI) / 60;
    this.d = {
      omegaMax,
      kT: p.tmax / (omegaMax * omegaMax),
      motors: MOTOR_POS.map(([sx, sz]) => ({ x: sx * p.arm, z: sz * p.arm })),
      I: { x: p.inertia[0], y: p.inertia[1], z: p.inertia[2] },
      diskA: Math.PI * p.propR * p.propR,
      vNom: 3.8 * p.cells,
      contacts: this.buildContacts(p),
    };
    this.cfg.mode = p.mode;
    this.cfg.rates = JSON.parse(JSON.stringify(p.rates));
    this.cfg.maxAngle = p.maxAngle;
  }

  buildContacts(p) {
    const a = p.arm, s = Math.max(0.35, p.scale);
    const c = [];
    for (const [sx, sz] of MOTOR_POS) {
      c.push({ r: v3(sx * a, -0.03 * s, sz * a), rad: 0.012 * s, leg: true });
      // Hélice: esfera só contra obstáculos; contra o chão, um ponto na ponta do disco.
      c.push({ r: v3(sx * a, 0.016 * s, sz * a), rad: p.propR * 0.92, prop: true, noGround: true });
      const k = 1 + p.propR / (a * Math.SQRT2);
      c.push({ r: v3(sx * a * k, 0.016 * s, sz * a * k), rad: 0.006 * s, prop: true });
    }
    c.push({ r: v3(0, -0.02 * s, 0), rad: 0.018 * s });
    c.push({ r: v3(0, 0.045 * s, 0.01), rad: 0.03 * s });
    c.push({ r: v3(0, 0.01 * s, -a * 0.95), rad: 0.022 * s });
    return c;
  }

  reset(spawn) {
    const w = this.world;
    const sp = spawn || w.spawn;
    const gy = sp.y !== undefined ? sp.y : w.heightAt(sp.x, sp.z);
    const legH = 0.042 * Math.max(0.35, this.p.scale);
    this.s = {
      pos: v3(sp.x, gy + legH + 0.002, sp.z),
      vel: v3(),
      q: Q.axisAngle(v3(0, 1, 0), sp.yaw || 0),
      w: v3(),
      motor: [0, 0, 0, 0],
      thrust: [0, 0, 0, 0],
      cmd: [0, 0, 0, 0],
      armed: false,
      crashed: false,
      time: 0,
      armTime: 0,
      onGround: true,
      groundTimer: 0,
      maxG: 0,
    };
    this.bat = { soc: 1, mah: 0, v: this.p.cells * 4.2, current: 0, power: 0 };
    this.resetController();
    this.tel = { sp: v3(), gyro: v3(), wind: v3(), vrs: 0, sat: false, agl: 0 };
  }

  resetController() {
    this.pid = { r: this.newPid(), p: this.newPid(), y: this.newPid() };
    this.airmode = false;
    this.posHold = null;
    this.altHold = null;
    this.vzI = 0;
    this.lastSat = false;
    this.wash = v3();
    this.auto = null;
    this.vI = v3();
  }
  newPid() { return { i: 0, prevMeas: 0, dF: 0, prevSp: 0, ffF: 0 }; }

  canArm(thr) {
    if (this.s.crashed) return 'RESETE O DRONE (R)';
    if (this.cfg.battery && this.bat.soc <= 0.01) return 'BATERIA VAZIA';
    if (this.cfg.mode !== 'pos' && thr > 0.08) return 'ABAIXE O ACELERADOR PARA ARMAR';
    if (this.cfg.mode === 'pos' && thr > 0.6) return 'ACELERADOR NO CENTRO PARA ARMAR';
    const up = Q.rot(this.s.q, v3(0, 1, 0));
    if (up.y < 0.5) return 'DRONE VIRADO';
    return null;
  }
  arm(thr) {
    const why = this.canArm(thr);
    if (why) return why;
    this.s.armed = true;
    this.resetController();
    this.emit('arm', true);
    return null;
  }
  disarm() {
    if (!this.s.armed) return;
    this.s.armed = false;
    this.emit('arm', false);
  }

  windAt(p, t) {
    const w = this.cfg.wind;
    if (!w.speed) return v3();
    const dir = w.dir * D2R;
    const hf = clamp(0.45 + p.y / 25, 0.45, 1.25);
    const g = w.gust;
    const gustA = 1 + g * (0.55 * Math.sin(t * 0.37 + p.x * 0.011) + 0.3 * Math.sin(t * 1.13 + p.z * 0.017) + 0.15 * Math.sin(t * 3.1));
    const side = g * 0.35 * Math.sin(t * 0.71 + p.z * 0.02);
    const sp = w.speed * hf;
    const fx = -Math.sin(dir), fz = -Math.cos(dir);
    return v3((fx * gustA - fz * side) * sp, g * 0.15 * sp * Math.sin(t * 0.9 + p.x * 0.03), (fz * gustA + fx * side) * sp);
  }

  // Avança a simulação pelo tempo de um quadro, em subpassos fixos de 400 Hz.
  update(frameDt, input) {
    const h = 1 / 400;
    this.acc = (this.acc || 0) + Math.min(frameDt, 0.1);
    let n = 0;
    while (this.acc >= h && n < 80) { this.step(h, input); this.acc -= h; n++; }
  }

  step(dt, inp) {
    const s = this.s, p = this.p, d = this.d, cfg = this.cfg;
    s.time += dt;
    if (s.armed) s.armTime += dt;

    const wind = this.windAt(s.pos, s.time);
    const vAirB = Q.invRot(s.q, sub(s.vel, wind));
    const agl = s.pos.y - this.world.heightAt(s.pos.x, s.pos.z);

    // ---- giroscópio (com ruído proporcional à rotação dos motores) ----
    let gyro = s.w;
    if (cfg.gyroNoise) {
      const mAvg = (s.motor[0] + s.motor[1] + s.motor[2] + s.motor[3]) / (4 * d.omegaMax);
      const n = 0.004 + 0.03 * mAvg * mAvg;
      gyro = v3(s.w.x + (Math.random() - 0.5) * n, s.w.y + (Math.random() - 0.5) * n, s.w.z + (Math.random() - 0.5) * n);
    }

    // ---- controladora ----
    if (s.armed) s.cmd = this.control(dt, inp, gyro);
    else s.cmd = [0, 0, 0, 0];

    // ---- bateria → rotação máxima disponível ----
    const vf = cfg.battery ? clamp(this.bat.v / d.vNom, 0, 1.12) : 1;
    const omegaTop = d.omegaMax * vf;
    const idle = 0.055 * d.omegaMax;

    // ---- aerodinâmica das hélices ----
    const axial = vAirB.y;
    const horiz = Math.hypot(vAirB.x, vAirB.z);
    const vrs = cfg.propWash ? smooth(1.2, 5, -axial) * (1 - smooth(2, 8, horiz)) : 0;
    const up = Q.rot(s.q, v3(0, 1, 0));
    let ge = 1;
    if (cfg.groundEffect && up.y > 0.5) {
      const hh = Math.max(agl, p.propR);
      const k = p.propR / (4 * hh);
      ge = 1 / (1 - Math.min(0.2, k * k));
    }

    const F = v3();
    const T = v3();
    let thrustSum = 0;
    for (let i = 0; i < 4; i++) {
      const target = s.armed ? Math.max(idle, s.cmd[i] * omegaTop) : 0;
      const tau = target > s.motor[i] ? p.tau : p.tau * 1.35;
      s.motor[i] += (target - s.motor[i]) * Math.min(1, dt / tau);
      const om = s.motor[i];
      const vPitch = (om / (2 * Math.PI)) * p.pitch;
      const inflow = vPitch > 0.5 ? clamp(1 - axial / vPitch, 0, 1.15) : 0;
      const t = d.kT * om * om * inflow * ge * (1 - 0.22 * vrs);
      s.thrust[i] = t;
      thrustSum += t;
      const m = d.motors[i];
      T.x += -m.z * t;
      T.z += m.x * t;
      T.y += -SPIN[i] * p.qt * t;
    }
    F.y += thrustSum;

    // ---- arrasto: corpo (quadrático por eixo) + rotores (linear) ----
    const vm = len(vAirB);
    const kq = 0.5 * RHO * vm;
    const rotorF = p.rotorDrag * (thrustSum / (4 * p.tmax) + 0.15);
    F.x += -kq * p.cda[0] * vAirB.x - rotorF * vAirB.x;
    F.y += -kq * p.cda[1] * vAirB.y;
    F.z += -kq * p.cda[2] * vAirB.z - rotorF * vAirB.z;

    // ---- prop wash: turbulência ao descer dentro do próprio fluxo ----
    if (vrs > 0.01) {
      const amp = vrs * (thrustSum / (4 * p.tmax) + 0.1) * 900 * dt;
      this.wash.x += (Math.random() - 0.5) * amp - this.wash.x * 25 * dt;
      this.wash.z += (Math.random() - 0.5) * amp - this.wash.z * 25 * dt;
      this.wash.y += (Math.random() - 0.5) * amp * 0.3 - this.wash.y * 25 * dt;
    } else {
      this.wash = scl(this.wash, 1 - 20 * dt);
    }
    T.x += this.wash.x * d.I.x * 4;
    T.y += this.wash.y * d.I.y * 4;
    T.z += this.wash.z * d.I.z * 4;

    // ---- integração ----
    const Fw = Q.rot(s.q, F);
    Fw.y -= p.mass * G;
    const acc = scl(Fw, 1 / p.mass);
    s.vel = add(s.vel, scl(acc, dt));
    s.pos = add(s.pos, scl(s.vel, dt));

    const w = s.w, I = d.I;
    const damp = 0.04;
    const Iw = v3(I.x * w.x, I.y * w.y, I.z * w.z);
    const gyroT = cross(w, Iw);
    s.w = v3(
      w.x + ((T.x - gyroT.x - damp * I.x * w.x * 10) / I.x) * dt,
      w.y + ((T.y - gyroT.y - damp * I.y * w.y * 10) / I.y) * dt,
      w.z + ((T.z - gyroT.z - damp * I.z * w.z * 10) / I.z) * dt,
    );
    const lim = 40;
    s.w = v3(clamp(s.w.x, -lim, lim), clamp(s.w.y, -lim, lim), clamp(s.w.z, -lim, lim));
    const dq = Q.mul(s.q, { x: s.w.x, y: s.w.y, z: s.w.z, w: 0 });
    s.q = Q.normalize({ x: s.q.x + 0.5 * dq.x * dt, y: s.q.y + 0.5 * dq.y * dt, z: s.q.z + 0.5 * dq.z * dt, w: s.q.w + 0.5 * dq.w * dt });

    this.contacts(dt);
    this.updateBattery(dt);

    const gload = len(sub(acc, v3(0, -G, 0))) / G;
    s.maxG = Math.max(s.maxG * (1 - dt * 0.5), gload);
    this.tel.wind = wind;
    this.tel.vrs = vrs;
    this.tel.agl = agl;
    this.tel.g = gload;
  }

  control(dt, inp, gyro) {
    const s = this.s, p = this.p, d = this.d, cfg = this.cfg;
    const mode = cfg.mode;
    const meas = { r: -gyro.z, p: -gyro.x, y: -gyro.y };
    const upC = Q.invRot(s.q, v3(0, 1, 0));
    let sp, tBase;

    if (mode === 'acro') {
      sp = {
        r: rateDps(inp.roll, cfg.rates.roll) * D2R,
        p: rateDps(inp.pitch, cfg.rates.pitch) * D2R,
        y: rateDps(inp.yaw, cfg.rates.yaw) * D2R,
      };
      tBase = p.tmax * inp.thr * inp.thr;
      if (inp.thr > 0.18) this.airmode = true;
    } else {
      const upW = Q.rot(s.q, v3(0, 1, 0));
      const fW = Q.rot(s.q, v3(0, 0, -1));
      let hx = fW.x, hz = fW.z;
      if (Math.hypot(hx, hz) < 0.2) { const sg = fW.y < 0 ? 1 : -1; hx = upW.x * sg; hz = upW.z * sg; }
      const psi = Math.atan2(-hx, -hz);
      const cy = Math.cos(psi), sy = Math.sin(psi);
      const toWorld = (lx, ly, lz) => v3(lx * cy + lz * sy, ly, -lx * sy + lz * cy);
      let upD;
      if (mode === 'angle') {
        const maxA = cfg.maxAngle * D2R;
        const ex = (x) => x * (0.65 + 0.35 * x * x);
        const rA = clamp(ex(inp.roll) * maxA, -1.45, 1.45), pA = clamp(ex(inp.pitch) * maxA, -1.45, 1.45);
        upD = norm(toWorld(Math.tan(rA), 1, -Math.tan(pA)));
        tBase = p.tmax * inp.thr * inp.thr;
        if (inp.thr > 0.18) this.airmode = true;
      } else {
        const r = this.positionControl(dt, inp, toWorld, upW);
        upD = r.upD;
        tBase = r.tBase;
      }
      const upDB = Q.invRot(s.q, upD);
      // Gira o "cima" do corpo (0,1,0) em direção ao vetor desejado, ambos no frame do corpo.
      const c = v3(upDB.z, 0, -upDB.x);
      const sn = len(c), cs = upDB.y;
      const ang = Math.atan2(sn, cs);
      const kA = 9;
      let wsp = sn > 1e-6 ? scl(c, (kA * ang) / sn) : v3();
      const maxR = 9;
      const l = Math.hypot(wsp.x, wsp.z);
      if (l > maxR) wsp = v3((wsp.x * maxR) / l, 0, (wsp.z * maxR) / l);
      const yawW = mode === 'pos' && this.auto ? this.auto.yawRate
        : -rateDps(inp.yaw, cfg.rates.yaw) * D2R * (mode === 'pos' ? (cfg.cine ? 0.22 : 0.5) : 1);
      wsp = add(wsp, scl(upC, yawW));
      sp = { r: -wsp.z, p: -wsp.x, y: -wsp.y };
    }

    // ---- PID de taxa (saída em aceleração angular) ----
    const kp = 1.2 / p.tau, ki = kp * 0.8, kd = 0.4, kff = 0.35;
    const active = this.airmode || tBase > p.tmax * 0.02;
    const aR = this.pidAxis(this.pid.r, sp.r, meas.r, dt, kp, ki, kd, kff, active);
    const aP = this.pidAxis(this.pid.p, sp.p, meas.p, dt, kp, ki, kd, kff, active);
    const aY = this.pidAxis(this.pid.y, sp.y, meas.y, dt, kp * 0.8, ki * 1.5, 0, kff * 0.6, active);
    this.tel.sp = v3(sp.r, sp.p, sp.y);
    this.tel.gyro = v3(meas.r, meas.p, meas.y);

    const dR = (d.I.z * aR) / (4 * p.arm);
    const dP = (d.I.x * aP) / (4 * p.arm);
    const dY = (d.I.y * aY) / (4 * p.qt);
    return this.mix(tBase, dR, dP, dY);
  }

  positionControl(dt, inp, toWorld, upW) {
    const s = this.s, p = this.p;
    const db = (x, z) => (Math.abs(x) < z ? 0 : (x - Math.sign(x) * z) / (1 - z));
    const sx = db(inp.roll, 0.06), sy = db(inp.pitch, 0.06);
    const cine = this.cfg.cine;
    const vmax = cine ? Math.min(4.5, p.maxSpeed || 12) : p.maxSpeed || 12;
    let vD;
    if (this.auto) {
      // Voo automático (QuickShots): o app manda a velocidade desejada no mundo.
      this.posHold = null;
      vD = v3(this.auto.vel.x, 0, this.auto.vel.z);
    } else if (sx === 0 && sy === 0) {
      const hv = Math.hypot(s.vel.x, s.vel.z);
      if (!this.posHold && hv < 0.8) this.posHold = v3(s.pos.x, 0, s.pos.z);
      if (this.posHold) {
        const ex = this.posHold.x - s.pos.x, ez = this.posHold.z - s.pos.z;
        const e = Math.hypot(ex, ez), m = Math.min(1, 4 / (e * 1.2 + 1e-6));
        vD = v3(ex * 1.2 * m, 0, ez * 1.2 * m);
      } else vD = v3();
    } else {
      this.posHold = null;
      vD = toWorld(sx * vmax, 0, -sy * vmax);
    }
    const kv = cine || this.auto ? 1.2 : 2.2;
    // PI de velocidade: o integral compensa arrasto e vento.
    const evx = vD.x - s.vel.x, evz = vD.z - s.vel.z;
    this.vI.x = clamp(this.vI.x + evx * 0.9 * dt, -4, 4);
    this.vI.z = clamp(this.vI.z + evz * 0.9 * dt, -4, 4);
    // Ao soltar os sticks, esquece o integral rápido para frear sem passar do ponto.
    if (!this.auto && sx === 0 && sy === 0) { this.vI.x *= 1 - 3 * dt; this.vI.z *= 1 - 3 * dt; }
    let ax = evx * kv + this.vI.x, az = evz * kv + this.vI.z;
    const amax = G * Math.tan((this.cfg.maxAngle || 35) * D2R);
    const al = Math.hypot(ax, az);
    if (al > amax) { ax *= amax / al; az *= amax / al; }

    const tz = db((inp.thr - 0.5) * 2, 0.1);
    let vzD;
    if (this.auto) {
      this.altHold = null;
      vzD = this.auto.vel.y;
    } else if (tz === 0) {
      if (this.altHold === null) this.altHold = s.pos.y + s.vel.y * 0.3;
      vzD = clamp((this.altHold - s.pos.y) * 1.8, -2, 2);
    } else {
      this.altHold = null;
      vzD = tz > 0 ? tz * (cine ? 2 : p.maxClimb || 5) : tz * (cine ? 1.5 : p.maxDescent || 3);
    }
    // Perto do chão a descida é suavizada (pouso assistido).
    if (vzD < 0) vzD = Math.max(vzD, -Math.max(0.6, this.tel.agl * 0.9));
    if (s.onGround && vzD <= 0.05) {
      this.vzI = 0; this.altHold = null; this.posHold = null; this.vI = v3();
      return { upD: v3(0, 1, 0), tBase: 0 };
    }
    const ez = vzD - s.vel.y;
    this.vzI = clamp(this.vzI + ez * 1.5 * dt, -5, 5);
    const azc = ez * 3 + this.vzI;
    const Tv = v3(p.mass * ax, p.mass * (G + azc), p.mass * az);
    const upD = norm(Tv);
    const col = Math.max(0, dot(Tv, upW));
    const vf = this.cfg.battery ? clamp(this.bat.v / this.d.vNom, 0.5, 1.12) : 1;
    this.airmode = true;
    return { upD, tBase: col / 4 / (vf * vf) };
  }

  pidAxis(st, sp, meas, dt, kp, ki, kd, kff, active) {
    const err = sp - meas;
    const dRaw = (meas - st.prevMeas) / dt;
    st.prevMeas = meas;
    st.dF += (dRaw - st.dF) * clamp(dt * 2 * Math.PI * 80, 0, 1);
    const spD = (sp - st.prevSp) / dt;
    st.prevSp = sp;
    st.ffF += (spD - st.ffF) * clamp(dt * 2 * Math.PI * 20, 0, 1);
    if (!active) st.i = 0;
    else if (!this.lastSat || Math.sign(err) !== Math.sign(st.i)) st.i = clamp(st.i + err * ki * dt, -kp * 1.5, kp * 1.5);
    return kp * err + st.i - kd * st.dF + kff * st.ffF;
  }

  // Mixer em espaço de empuxo com airmode e saturação proporcional.
  mix(tBase, dR, dP, dY) {
    const tmax = this.p.tmax;
    const diff = [0, 0, 0, 0];
    // Yaw tem prioridade menor: limitado ao que sobra depois de roll/pitch.
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 4; i++) {
      diff[i] = MIX_ROLL[i] * dR + MIX_PITCH[i] * dP;
      lo = Math.min(lo, diff[i]); hi = Math.max(hi, diff[i]);
    }
    const room = Math.max(0, tmax - (hi - lo)) / 2;
    const dYc = clamp(dY, -Math.max(room, tmax * 0.12), Math.max(room, tmax * 0.12));
    lo = Infinity; hi = -Infinity;
    for (let i = 0; i < 4; i++) {
      diff[i] += SPIN[i] * dYc;
      lo = Math.min(lo, diff[i]); hi = Math.max(hi, diff[i]);
    }
    let sat = dYc !== dY;
    let k = 1;
    if (hi - lo > tmax) { k = tmax / (hi - lo); sat = true; }
    const t = diff.map((x) => tBase + x * k);
    lo = Math.min(...t); hi = Math.max(...t);
    if (this.airmode) {
      if (lo < 0) { for (let i = 0; i < 4; i++) t[i] -= lo; sat = true; }
      hi = Math.max(...t);
      if (hi > tmax) { for (let i = 0; i < 4; i++) t[i] -= hi - tmax; sat = true; }
    } else if (hi > tmax) {
      for (let i = 0; i < 4; i++) t[i] -= hi - tmax;
      sat = true;
    }
    this.lastSat = sat;
    this.tel.sat = sat;
    return t.map((x) => Math.sqrt(clamp(x / tmax, 0, 1)));
  }

  // Contatos: impulsos sequenciais com várias iterações (distribui o impacto entre os pés).
  contacts(dt) {
    const s = this.s, d = this.d, p = this.p, m = p.mass;
    const invIw = (v) => { const b = Q.invRot(s.q, v); return Q.rot(s.q, v3(b.x / d.I.x, b.y / d.I.y, b.z / d.I.z)); };
    const kOf = (r, n) => 1 / m + dot(n, cross(invIw(cross(r, n)), r));
    const velAt = (r) => add(s.vel, cross(Q.rot(s.q, s.w), r));
    let legTouch = false;
    const list = [];
    let push = v3(), maxPen = 0;
    for (const c of d.contacts) {
      const rw = Q.rot(s.q, c.r);
      const cp = add(s.pos, rw);
      const hit = this.world.collideSphere(cp.x, cp.y, cp.z, c.rad, c.noGround);
      if (!hit) continue;
      const n = v3(hit.nx, hit.ny, hit.nz);
      if (c.leg && hit.ny > 0.6) legTouch = true;
      const r = sub(rw, scl(n, c.rad));
      const vn0 = dot(velAt(r), n);
      if (hit.pen > maxPen) { maxPen = hit.pen; push = scl(n, hit.pen); }
      if (vn0 < 0) {
        const impact = -vn0;
        if (s.armed && impact > p.crash) this.crash(impact, hit.kind);
        else if (impact > 1.5) this.emit('bump', { impact, kind: hit.kind, prop: !!c.prop });
      }
      const e = vn0 < -1.5 ? (c.prop ? 0.3 : 0.15) : 0;
      list.push({ r, n, kn: kOf(r, n), target: Math.max(0, -e * vn0), jn: 0, mu: hit.kind === 'ground' ? 0.7 : 0.45 });
    }
    if (maxPen > 0.0005) s.pos = add(s.pos, scl(push, 0.6 * (1 - 0.0005 / maxPen)));
    for (let it = 0; it < 6 && list.length; it++) {
      for (const c of list) {
        const vn = dot(velAt(c.r), c.n);
        let j = (c.target - vn) / c.kn;
        const old = c.jn;
        c.jn = Math.max(0, old + j);
        j = c.jn - old;
        if (j !== 0) this.applyImpulse(scl(c.n, j), c.r);
        const vc = velAt(c.r);
        const vt = sub(vc, scl(c.n, dot(vc, c.n)));
        const vtl = len(vt);
        if (vtl > 1e-6 && c.jn > 0) {
          const tdir = scl(vt, 1 / vtl);
          const jt = Math.min(vtl / kOf(c.r, tdir), c.mu * c.jn);
          this.applyImpulse(scl(tdir, -jt), c.r);
        }
      }
    }
    if (legTouch) s.groundTimer = 0.08;
    else s.groundTimer = Math.max(0, s.groundTimer - dt);
    s.onGround = s.groundTimer > 0;
  }

  applyImpulse(J, r) {
    const s = this.s, d = this.d;
    s.vel = add(s.vel, scl(J, 1 / this.p.mass));
    const tb = Q.invRot(s.q, cross(r, J));
    s.w = v3(s.w.x + tb.x / d.I.x, s.w.y + tb.y / d.I.y, s.w.z + tb.z / d.I.z);
  }

  crash(impact, kind) {
    const s = this.s;
    if (s.crashed) return;
    s.crashed = true;
    s.armed = false;
    this.emit('crash', { impact, kind });
  }

  updateBattery(dt) {
    const b = this.bat, p = this.p, d = this.d;
    let P = this.s.armed ? 0.6 * p.cells : 0.25 * p.cells;
    const k = Math.sqrt(2 * RHO * d.diskA);
    for (let i = 0; i < 4; i++) P += Math.pow(this.s.thrust[i], 1.5) / k / p.eff;
    if (!this.cfg.battery) {
      b.v = 4.05 * p.cells; b.current = P / b.v; b.power = P;
      return;
    }
    const ocv = cellOcv(b.soc) * p.cells;
    const rEff = p.rint * (1 + 2.5 * (1 - smooth(0, 0.15, b.soc)));
    const I = P / Math.max(b.v, p.cells * 2.5);
    b.current = I;
    b.power = P;
    b.v = Math.max(p.cells * 2.6, ocv - I * rEff);
    b.mah += (I * dt) / 3.6;
    b.soc = clamp(1 - b.mah / p.capacity, 0, 1);
  }

  // Valores prontos para o OSD.
  telemetry() {
    const s = this.s, b = this.bat;
    const up = Q.rot(s.q, v3(0, 1, 0));
    const fwd = Q.rot(s.q, v3(0, 0, -1));
    return {
      armed: s.armed, crashed: s.crashed, mode: MODES[this.cfg.mode],
      alt: this.tel.agl, altMsl: s.pos.y,
      speed: len(s.vel), vz: s.vel.y,
      volt: b.v, cell: b.v / this.p.cells, amps: b.current, mah: b.mah, soc: b.soc,
      armTime: s.armTime, gload: this.tel.g || 1,
      pitch: Math.asin(clamp(fwd.y, -1, 1)),
      roll: Math.atan2(-Q.invRot(s.q, v3(0, 1, 0)).x, Q.invRot(s.q, v3(0, 1, 0)).y),
      heading: Math.atan2(-fwd.x, -fwd.z), upY: up.y,
      motors: s.motor.map((x) => x / this.d.omegaMax),
      wind: this.tel.wind, vrs: this.tel.vrs, sat: this.tel.sat, onGround: s.onGround,
    };
  }
}
