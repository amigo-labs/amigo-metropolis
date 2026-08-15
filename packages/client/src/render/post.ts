// Post pipeline: threshold bloom over the composed frame (EffectComposer →
// RenderPass → UnrealBloomPass → OutputPass).
//
// The selectivity is free and comes from the material split that already
// exists: every combat effect (tracers, bolts, arcs, explosions) is an
// additive material with toneMapped: false (render/fx.ts), so it lands in the
// buffer at full intensity and crosses the bloom threshold, while the
// ACES-mapped world below rarely does. Nothing tags meshes for bloom.
//
// Renderer rule 1 holds: the composer, passes and render targets are built
// once here; render() is a camera property write plus composer.render(), and
// setSize only runs from the resize handler.

import type * as THREE from "three";
import { Vector2 } from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

/** Tuning: threshold keeps the ACES-mapped world out; strength stays subtle. */
const BLOOM_STRENGTH = 0.55;
const BLOOM_RADIUS = 0.4;
const BLOOM_THRESHOLD = 0.85;

export interface PostPipeline {
  /** Renders the scene through the composer with `camera`. */
  render(camera: THREE.Camera): void;
  setSize(width: number, height: number, pixelRatio: number): void;
  /** Frees the composer's render targets. */
  dispose(): void;
}

export function createPost(renderer: THREE.WebGLRenderer, scene: THREE.Scene): PostPipeline {
  const size = new Vector2();
  renderer.getSize(size);
  const composer = new EffectComposer(renderer);
  // The camera is swapped per render() call; the placeholder is never used
  // before the first call assigns a real one.
  const renderPass = new RenderPass(scene, null as unknown as THREE.Camera);
  const bloomPass = new UnrealBloomPass(size, BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD);
  const outputPass = new OutputPass();
  composer.addPass(renderPass);
  composer.addPass(bloomPass);
  composer.addPass(outputPass);

  return {
    render(camera: THREE.Camera): void {
      renderPass.camera = camera;
      composer.render();
    },
    setSize(width: number, height: number, pixelRatio: number): void {
      composer.setPixelRatio(pixelRatio);
      composer.setSize(width, height);
    },
    dispose(): void {
      composer.dispose();
    },
  };
}

/**
 * True when WebGL runs on a software rasterizer (SwiftShader — the CI/e2e
 * environment). Full-screen bloom there costs seconds per frame, so it
 * defaults off; `?bloom=1` still forces it for a deliberate look check.
 */
export function isSoftwareRenderer(renderer: THREE.WebGLRenderer): boolean {
  const gl = renderer.getContext();
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const name = info
    ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL))
    : String(gl.getParameter(gl.RENDERER));
  return /swiftshader|software|llvmpipe/i.test(name);
}
