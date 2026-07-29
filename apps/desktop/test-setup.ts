/**
 * Browser globals that CesiumJS probes for without guarding.
 *
 * `Material.getUniformType` decides a uniform's GLSL type with a chain of bare
 * `instanceof` checks:
 *
 *     uniformValue instanceof HTMLCanvasElement ||
 *     uniformValue instanceof HTMLImageElement  || …
 *
 * There's no `typeof … !== 'undefined'` guard, so under Vitest's node
 * environment the *reference itself* throws before the check can answer. That
 * kills `Material.fromType('Color', …)`, which the active-faults layer needs.
 *
 * Declaring these as empty classes makes every check evaluate to `false` —
 * which is the correct answer for a `Cesium.Color` uniform. So this restores
 * Cesium's intended behaviour rather than faking it.
 *
 * The alternative was adding jsdom or happy-dom purely for this. That's a real
 * dependency and it would slow down every test in the package, all to supply
 * four constructors that are only ever used in an `instanceof` that should
 * return false.
 */
const BROWSER_GLOBALS = [
  'HTMLCanvasElement',
  'HTMLImageElement',
  'HTMLVideoElement',
  'ImageBitmap',
  'OffscreenCanvas',
] as const;

for (const name of BROWSER_GLOBALS) {
  if (!(name in globalThis)) {
    Object.defineProperty(globalThis, name, {
      value: class {},
      writable: true,
      configurable: true,
    });
  }
}
