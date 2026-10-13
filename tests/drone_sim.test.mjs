// Testes da física do simulador FPV (interface/drone). Rode com: node --test tests/drone_sim.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../interface/drone/world.js';
import { Drone, PRESETS, rateDps } from '../interface/drone/sim.js';

const world = createWorld(1337);
const run = (d, secs, inp) => { for (let i = 0; i < secs * 400; i++) d.step(1 / 400, inp); };
const centered = { thr: 0.5, roll: 0, pitch: 0, yaw: 0 };

test('rates Betaflight: RC 1.0 / Super 0.7 dá 667°/s no fim do stick', () => {
  assert.equal(Math.round(rateDps(1, { rcRate: 1, superRate: 0.7, expo: 0 })), 667);
  assert.equal(rateDps(0, { rcRate: 1, superRate: 0.7, expo: 0.3 }), 0);
});

test('drone parado fica estável no chão e só arma com acelerador baixo', () => {
  const d = new Drone(world, 'racer');
  run(d, 1, { thr: 0, roll: 0, pitch: 0, yaw: 0 });
  assert.ok(d.s.onGround);
  assert.ok(d.telemetry().upY > 0.99);
  assert.match(d.arm(0.5), /ACELERADOR/);
  assert.equal(d.arm(0), null);
});

for (const key of Object.keys(PRESETS)) {
  test(`${key}: resposta de taxa em ACRO segue o setpoint`, () => {
    const d = new Drone(world, key);
    d.cfg.gyroNoise = false; d.cfg.battery = false;
    d.reset({ x: 0, z: 0, y: 60, yaw: 0 });
    d.s.armed = true; d.airmode = true; d.cfg.mode = 'acro';
    const hov = Math.sqrt((PRESETS[key].mass * 9.81) / 4 / PRESETS[key].tmax);
    run(d, 0.4, { thr: hov, roll: 0.6, pitch: 0, yaw: 0 });
    const err = Math.abs(d.tel.gyro.x - d.tel.sp.x) / d.tel.sp.x;
    assert.ok(err < 0.05, `erro de taxa ${(err * 100).toFixed(1)}%`);
  });

  test(`${key}: modo GPS decola, segura posição com vento e pousa de pé`, () => {
    const d = new Drone(world, key);
    d.cfg.mode = 'pos';
    d.cfg.wind = { speed: 6, dir: 90, gust: 0.4 };
    assert.equal(d.arm(0.5), null);
    run(d, 3, { ...centered, thr: 0.9 });
    assert.ok(d.telemetry().alt > 5, 'subiu');
    run(d, 3, centered);
    const p0 = { ...d.s.pos };
    run(d, 4, centered);
    assert.ok(Math.hypot(d.s.pos.x - p0.x, d.s.pos.z - p0.z) < 1.5, 'segurou posição');
    run(d, 15, { ...centered, thr: 0 });
    const t = d.telemetry();
    assert.ok(t.onGround && !t.crashed && t.upY > 0.98, 'pousou de pé');
  });
}

test('colisão rápida contra prédio derruba o drone', () => {
  const d = new Drone(world, 'racer');
  d.reset({ x: -175, z: -90, y: 8, yaw: 0 });
  d.s.armed = true;
  d.s.vel = { x: 0, y: 0, z: -20 };
  let hit = null;
  d.on('crash', (e) => { hit = e; });
  run(d, 2, { thr: 0.3, roll: 0, pitch: 0, yaw: 0 });
  assert.equal(hit?.kind, 'building');
  assert.ok(d.s.pos.z > -115, 'não atravessou a parede');
});

test('portal conta só no sentido da pista e dentro da abertura', () => {
  const g = world.gates[0];
  const at = (k, dy = 0) => ({ x: g.x + g.normal.x * k, y: g.cy + dy, z: g.z + g.normal.z * k });
  assert.ok(world.gateCrossed(g, at(-1), at(1)));
  assert.ok(!world.gateCrossed(g, at(1), at(-1)));
  assert.ok(!world.gateCrossed(g, at(-1, 2), at(1, 2)));
});

test('bateria de 5" dura entre 8 e 20 min em hover', () => {
  const d = new Drone(world, 'racer');
  d.reset({ x: 0, z: 0, y: 30, yaw: 0 });
  d.cfg.mode = 'pos'; d.s.armed = true;
  let t = 0;
  while (d.bat.soc > 0.2 && t < 1500) { run(d, 1, centered); t++; }
  assert.ok(t > 8 * 60 && t < 20 * 60, `${(t / 60).toFixed(1)} min`);
});

test('voo automático segue a velocidade pedida e o modo Cine limita a velocidade', () => {
  const d = new Drone(world, 'camera');
  d.reset({ x: 0, z: 0, y: 20, yaw: 0 });
  d.cfg.mode = 'pos'; d.s.armed = true;
  d.auto = { vel: { x: 3, y: 1, z: 0 }, yawRate: 0 };
  run(d, 5, centered);
  assert.ok(Math.abs(d.s.vel.x - 3) < 0.4 && Math.abs(d.s.vel.y - 1) < 0.3, `vel ${d.s.vel.x.toFixed(2)}, ${d.s.vel.y.toFixed(2)}`);
  d.auto = null;
  d.cfg.cine = true;
  run(d, 6, { ...centered, pitch: 1 });
  assert.ok(Math.hypot(d.s.vel.x, d.s.vel.z) < 5, 'Cine até 4,5 m/s');
});
