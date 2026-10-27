// Post pipeline: threshold bloom over the composed frame (EffectComposer →
// RenderPass → UnrealBloomPass → a plain copy to the canvas).
//
// The frame is composed as the original's frame buffer is (fcop-fidelity.md
// G13): in display values. Every add of the original -- the `add` faces'
// (ONE, ONE), the stars, the DCSQuads, the effects -- sums onto the 16-bit
// frame buffer's own bytes (Glide's `grAlphaBlendFunction` 0x00439ee5,
// d3da's SRCBLEND / DESTBLEND ONE / ONE, RE M3-OO), and a half face averages
// with them; the canvas path does the same (three encodes each fragment
// before the blend). Under the composer three would compose in linear light
// and encode once at the end, so a sum of two adds came out brighter than the
// original's and a half face averaged the wrong values. So the composer's two
// targets are marked as display targets (displayTarget): three renders into
// them as into the canvas -- tone-mapped per material and sRGB-encoded per
// fragment, the blends on the encoded values -- and the last pass copies them
// out unchanged. The bloom reads and adds display values. A half-float
// target keeps an add's excess over 1 until the copy clamps it, where the
// 8-bit frame buffer clamps each write: the same sum for adds alone, another
// value only where a half face lands on a saturated add.
//
// The selectivity is free and comes from the material split that already
// exists: every combat effect (tracers, bolts, arcs, explosions) is an
// additive material with toneMapped: false (render/fx.ts), so it lands in the
// buffer at full intensity and crosses the bloom threshold, while the
// ACES-mapped world below rarely does -- now true under the composer as well,
// which until the display targets tone-mapped everything once at the end.
// Nothing tags meshes for bloom.
//
// Renderer rule 1 holds: the composer, passes and render targets are built
// once here; render() is a camera property write plus composer.render(), and
// setSize only runs from the resize handler.

import type * as THREE from "three";
import { HalfFloatType, SRGBColorSpace, Vector2, WebGLRenderTarget } from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { CopyShader } from "three/addons/shaders/CopyShader.js";

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

/**
 * Marks `target` as a display target: three's WebGL renderer then draws into
 * it as into the canvas -- each material's tone mapping, the fragment encoded
 * to `target.texture.colorSpace` (sRGB), so every blend runs on the encoded
 * values (WebGLPrograms / WebGLRenderer read `isXRRenderTarget` for exactly
 * those two choices, three r185; its only other reader is a multisampled
 * renderbuffer's format, and these targets take no samples).
 */
export function displayTarget(target: WebGLRenderTarget): WebGLRenderTarget {
  target.texture.colorSpace = SRGBColorSpace;
  (target as WebGLRenderTarget & { isXRRenderTarget: boolean }).isXRRenderTarget = true;
  return target;
}

export function createPost(renderer: THREE.WebGLRenderer, scene: THREE.Scene): PostPipeline {
  const size = new Vector2();
  renderer.getSize(size);
  const pixelRatio = renderer.getPixelRatio();
  const target = displayTarget(
    new WebGLRenderTarget(size.x * pixelRatio, size.y * pixelRatio, { type: HalfFloatType }),
  );
  const composer = new EffectComposer(renderer, target);
  // The clone does not carry the mark.
  displayTarget(composer.renderTarget2);
  // The camera is swapped per render() call; the placeholder is never used
  // before the first call assigns a real one.
  const renderPass = new RenderPass(scene, null as unknown as THREE.Camera);
  const bloomPass = new UnrealBloomPass(size, BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD);
  // Display values already: copied out as they are, no second tone map or encode.
  const outputPass = new ShaderPass(CopyShader);
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
