// Modo Mundo Real: cidades reais em 3D (Google Photorealistic 3D Tiles) com colisão por raios.
// Carregado sob demanda: o simulador base não depende destes pacotes.
import * as THREE from 'three';
import { TilesRenderer } from '3d-tiles-renderer/three';
import { GoogleCloudAuthPlugin, ReorientationPlugin, GLTFExtensionsPlugin } from '3d-tiles-renderer/plugins';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

export { PLACES } from './places.js';

const DRACO_PATH = 'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/libs/draco/gltf/';

// Mundo "virtual" que a física usa: o chão e as paredes vêm de raios lançados contra a malha real.
export function createRealWorld({ scene, camera, renderer, apiKey, lat, lon, onStatus }) {
  const tiles = new TilesRenderer();
  tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: apiKey, autoRefreshToken: true }));
  const draco = new DRACOLoader().setDecoderPath(DRACO_PATH);
  tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: draco }));
  tiles.registerPlugin(new ReorientationPlugin({ lat: lat * THREE.MathUtils.DEG2RAD, lon: lon * THREE.MathUtils.DEG2RAD, height: 0, recenter: true }));
  tiles.errorTarget = 12;
  tiles.setCamera(camera);
  tiles.setResolutionFromRenderer(camera, renderer);
  scene.add(tiles.group);

  let error = null;
  tiles.addEventListener('load-error', (e) => {
    const msg = String(e?.error?.message || e?.error || 'erro');
    if (!error) { error = msg; onStatus?.({ error: msg }); }
  });
  tiles.addEventListener('load-model', ({ scene: s }) => {
    // As texturas do Google já têm a luz do dia "assada": desliga o tone mapping para manter as cores.
    s.traverse((o) => {
      if (o.material) {
        o.material.toneMapped = false;
        o.receiveShadow = false;
        o.castShadow = false;
      }
    });
  });

  const ray = new THREE.Raycaster();
  ray.firstHitOnly = true;
  const down = new THREE.Vector3(0, -1, 0);
  const tmp = new THREE.Vector3();
  const planes = []; // { p: Vector3, n: Vector3 } encontrados perto do drone
  let ground = null; // { y, n } logo abaixo do drone
  let groundXZ = { x: 0, z: 0 };

  function cast(origin, dir, far) {
    ray.set(origin, dir);
    ray.far = far;
    const hits = ray.intersectObject(tiles.group, true);
    const h = hits[0];
    if (!h) return null;
    const n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
    if (n.dot(dir) > 0) n.negate();
    return { p: h.point.clone(), n, d: h.distance };
  }

  // Direções para procurar paredes e chão em volta do drone.
  const DIRS = [];
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; DIRS.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a))); }
  for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2 + 0.4; DIRS.push(new THREE.Vector3(Math.cos(a), -0.8, Math.sin(a)).normalize()); }
  DIRS.push(new THREE.Vector3(0, 1, 0));

  const world = {
    real: true,
    tiles,
    gates: [], pads: [], trees: [], structures: [], town: [], roads: [], lamps: [],
    spawn: { x: 0, z: 0, yaw: 0, y: 0 },
    pilot: { x: 0, y: 1.7, z: 6 },
    ready: false,
    heightAt(x, z) {
      if (ground && Math.hypot(x - groundXZ.x, z - groundXZ.z) < 6) {
        // Plano do chão encontrado pelo raio para baixo.
        return ground.y - ((x - groundXZ.x) * ground.n.x + (z - groundXZ.z) * ground.n.z) / Math.max(0.2, ground.n.y);
      }
      return ground ? ground.y : -1e4;
    },
    normalAt() { return ground ? ground.n : { x: 0, y: 1, z: 0 }; },
    collideSphere(px, py, pz, r) {
      let best = null;
      const gh = world.heightAt(px, pz);
      if (py - r < gh) {
        const pen = gh - (py - r);
        best = { pen: Math.min(pen, 0.5), nx: ground ? ground.n.x : 0, ny: ground ? ground.n.y : 1, nz: ground ? ground.n.z : 0, kind: 'ground' };
      }
      for (const pl of planes) {
        const dx = px - pl.p.x, dy = py - pl.p.y, dz = pz - pl.p.z;
        if (dx * dx + dy * dy + dz * dz > 9) continue;
        const dist = dx * pl.n.x + dy * pl.n.y + dz * pl.n.z;
        if (dist < r && dist > -0.6) {
          const pen = r - dist;
          if (!best || pen > best.pen) best = { pen, nx: pl.n.x, ny: pl.n.y, nz: pl.n.z, kind: 'building' };
        }
      }
      return best;
    },
    gateCrossed: () => false,
    lineOfSight: () => 0,

    // Chamado uma vez por quadro com a posição do drone.
    probe(pos) {
      tmp.set(pos.x, pos.y + 2, pos.z);
      const g = cast(tmp, down, 3000);
      if (g) { ground = { y: g.p.y, n: g.n }; groundXZ = { x: pos.x, z: pos.z }; }
      planes.length = 0;
      tmp.set(pos.x, pos.y, pos.z);
      for (const d of DIRS) {
        const h = cast(tmp, d, 4);
        if (h) planes.push(h);
      }
      return !!g;
    },
    // Acha o chão no ponto de partida depois que a cidade começa a carregar.
    findSpawn() {
      const g = cast(new THREE.Vector3(0, 9000, 0), down, 12000);
      if (!g) return null;
      world.spawn = { x: 0, z: 0, yaw: 0, y: g.p.y + 0.05 };
      world.pilot = { x: 0, y: g.p.y + 1.7, z: 6 };
      ground = { y: g.p.y, n: g.n };
      groundXZ = { x: 0, z: 0 };
      world.ready = true;
      return world.spawn;
    },
    update(cam, rend, quality) {
      tiles.errorTarget = quality === 'ultra' ? 6 : quality === 'high' ? 10 : quality === 'medium' ? 16 : 24;
      tiles.setResolutionFromRenderer(cam, rend);
      cam.updateMatrixWorld();
      tiles.update();
    },
    attribution() {
      const a = tiles.getAttributions();
      return a.filter((x) => x.type === 'string').map((x) => x.value).join(' · ');
    },
    error: () => error,
    dispose() {
      scene.remove(tiles.group);
      tiles.dispose();
      draco.dispose();
    },
  };
  return world;
}
