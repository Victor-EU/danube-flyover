// Post-processing: the scene renders into a multisampled half-float target, bloom picks out
// what is brighter than its threshold (lamps, lit windows, the sun), and the output pass
// applies ACES tone mapping at the lighting's exposure and converts to sRGB.

import { HalfFloatType, Vector2, WebGLRenderTarget, type Camera, type Scene, type WebGLRenderer } from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { QUALITY } from "./config";

export class Post {
  private readonly composer: EffectComposer;
  /** The HDR target the scene renders into (programs compiled for it differ from the canvas's). */
  readonly target: WebGLRenderTarget;
  private readonly render: RenderPass;
  readonly bloom: UnrealBloomPass;

  constructor(
    private readonly renderer: WebGLRenderer,
    scene: Scene,
    camera: Camera,
  ) {
    this.target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: this.samplesFor(QUALITY.samples) });
    this.composer = new EffectComposer(renderer, this.target);
    this.render = new RenderPass(scene, camera);
    this.bloom = new UnrealBloomPass(new Vector2(1, 1), 0.6, 0.5, 0.9);
    this.bloom.enabled = QUALITY.bloom;
    this.composer.addPass(this.render);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  /**
   * A multisampled half-float target is 8 bytes a sample: on a high-density screen, which
   * already has the pixels to smooth edges, two samples instead of four halve its cost.
   */
  private samplesFor(n: number): number {
    return this.renderer.getPixelRatio() >= 1.5 ? Math.min(2, n) : n;
  }

  /** MSAA samples of the scene target (and the composer's second buffer). */
  setSamples(n: number): void {
    const samples = this.samplesFor(n);
    for (const rt of [this.composer.renderTarget1, this.composer.renderTarget2]) {
      if (rt.samples === samples) continue;
      rt.samples = samples;
      rt.dispose();
    }
  }

  setCamera(camera: Camera): void {
    this.render.camera = camera;
  }

  setBloom(strength: number, threshold: number, radius: number): void {
    this.bloom.strength = strength;
    this.bloom.threshold = threshold;
    this.bloom.radius = radius;
    this.bloom.enabled = QUALITY.bloom && strength > 0.001;
  }

  setSize(width: number, height: number): void {
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(width, height);
  }

  draw(): void {
    this.composer.render();
  }
}
