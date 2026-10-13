// Pós-processamento: bloom, tone mapping e lente (distorção grande-angular, aberração cromática, vinheta e granulado).
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const LensShader = {
  uniforms: {
    tDiffuse: { value: null }, time: { value: 0 },
    distortion: { value: 0 }, aberration: { value: 0 }, vignette: { value: 0.35 }, grain: { value: 0.03 },
    aspect: { value: 1 }, sunUv: { value: new THREE.Vector2(-9, -9) }, sunAmt: { value: 0 },
  },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float time, distortion, aberration, vignette, grain, aspect, sunAmt;
    uniform vec2 sunUv;
    varying vec2 vUv;
    float rand(vec2 co) { return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }
    vec2 warp(vec2 uv, float k) {
      vec2 c = uv - 0.5; c.x *= aspect;
      float r2 = dot(c, c);
      float rmax2 = 0.25 * aspect * aspect + 0.25;
      c *= (1.0 + k * r2) / (1.0 + k * rmax2);
      c.x /= aspect;
      return c + 0.5;
    }
    void main() {
      vec2 uv = warp(vUv, distortion);
      vec2 d = (uv - 0.5) * aberration;
      vec3 col = vec3(texture2D(tDiffuse, uv + d).r, texture2D(tDiffuse, uv).g, texture2D(tDiffuse, uv - d).b);
      float v = smoothstep(0.9, 0.3, length(vUv - 0.5) * 1.15);
      // Reflexo do sol na lente: brilho em volta do sol e "fantasmas" na linha que cruza o centro.
      if (sunAmt > 0.0) {
        vec2 a = vec2(aspect, 1.0);
        col += vec3(1.0, 0.93, 0.8) * sunAmt * 0.35 * exp(-length((vUv - sunUv) * a) * 7.0);
        vec2 axis = vec2(0.5) - sunUv;
        for (int i = 1; i <= 4; i++) {
          float k = float(i) * 0.42;
          vec2 g = sunUv + axis * k * 1.2;
          float r = 0.025 + 0.02 * float(i);
          float d = length((vUv - g) * a);
          float ring = smoothstep(r, r * 0.7, d) * (0.5 + 0.5 * smoothstep(r * 0.4, r, d));
          col += mix(vec3(0.5, 0.75, 1.0), vec3(1.0, 0.65, 0.4), float(i) / 4.0) * ring * sunAmt * 0.06;
        }
      }
      col *= mix(1.0, v, vignette);
      col += (rand(vUv * 913.0 + time) - 0.5) * grain;
      gl_FragColor = vec4(col, 1.0);
    }`,
};

export function createPost(renderer, scene, camera) {
  const size = new THREE.Vector2();
  const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.32, 0.55, 0.88);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const lens = new ShaderPass(LensShader);
  composer.addPass(lens);
  let enabled = true;
  const api = {
    get enabled() { return enabled; },
    set enabled(v) { enabled = v; },
    lens: lens.uniforms,
    bloom,
    setSamples(n) { rt.samples = n; composer.renderTarget1.samples = n; composer.renderTarget2.samples = n; },
    resize() {
      renderer.getSize(size);
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(size.x, size.y);
      lens.uniforms.aspect.value = size.x / Math.max(1, size.y);
    },
    render(dt) {
      if (!enabled) { renderer.render(scene, camera); return; }
      lens.uniforms.time.value = (lens.uniforms.time.value + dt) % 100;
      composer.render(dt);
    },
  };
  return api;
}
