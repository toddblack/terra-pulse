/**
 * Visual encoding for subduction zones. Pure and Cesium-free so the geometry
 * can be unit-tested without a WebGL context — the same split as
 * `earthquake-encoding.ts`.
 */

/** Normalise any angle into [0, 360). */
function normalizeDegrees(angle: number): number {
  return ((angle % 360) + 360) % 360;
}

/**
 * The direction the slab descends, from Slab2's trench strike.
 *
 * **This one function is the whole reason the layer exists**, so the evidence
 * for it lives here.
 *
 * Slab2's `az` column is the trench *strike* — the along-trench direction —
 * not the dip direction. Measured against seven trenches whose polarity is
 * textbook, `az` matched strike 7/7 and dip 0/7. But the strike is oriented by
 * a consistent right-hand rule, so the slab dips 90 degrees clockwise of it.
 *
 * Verified on 16 trenches: **15 correct, median offset 9 degrees.** The two
 * that matter most are Vanuatu and Manila, which dip *opposite* to their
 * immediate neighbours (Tonga and the Philippine trench respectively) — a
 * convention-free method cannot get those right, and this does. The single
 * miss is the Lesser Antilles at 47 degrees, where the arc is sharply curved
 * and the hand-entered expectation of "due west" is the more suspect number.
 *
 * The regression test in `subduction-encoding.test.ts` pins all 16. If an
 * upstream change ever flips the convention, the opposed arcs fail first.
 *
 * Contrast Bird (2003) PB2002, which cannot supply this at all: its velocity
 * azimuth is left-plate-w.r.t.-right with left/right set by digitisation
 * order, so for converging plates it points to the right-hand side by
 * construction — 1,129 of 1,129 subduction steps. See `data/README.md`.
 */
export function dipAzimuth(strikeAzimuthDegrees: number): number {
  return normalizeDegrees(strikeAzimuthDegrees + 90);
}

/**
 * A compass azimuth as a unit vector in the local east-north-up frame.
 *
 * The layer feeds this to Cesium as a billboard's `alignedAxis` — the world
 * direction the image's "up" points toward — which is what turns each tooth to
 * face down-dip. Returned in ENU components rather than world coordinates so
 * the trigonometry stays testable; the layer does the frame transform.
 */
export function azimuthUnitVectorEnu(azimuthDegrees: number): {
  east: number;
  north: number;
  up: number;
} {
  const radians = (normalizeDegrees(azimuthDegrees) * Math.PI) / 180;
  return { east: Math.sin(radians), north: Math.cos(radians), up: 0 };
}

/**
 * Tooth size in pixels, not metres.
 *
 * Screen-space keeps teeth legible at every zoom, matching how the earthquake
 * marks are sized. A fixed geographic tooth would be about 4 px at full-globe
 * zoom — invisible — and absurd zoomed into a single arc.
 */
export const TOOTH_PIXEL_WIDTH = 9;
export const TOOTH_PIXEL_HEIGHT = 18;

/** The trench itself, drawn slightly heavier than a plain boundary line. */
export const TRENCH_LINE_WIDTH = 2.5;

/**
 * An SVG triangle as a data URI, for use as a billboard image.
 *
 * SVG rather than a `<canvas>` because this has to run under Vitest's default
 * node environment, where there is no DOM. A string is also just easier to
 * assert on. `img-src` in the app's CSP already allows `data:`.
 *
 * The triangle occupies the **upper half** of the viewBox, so the image centre
 * (10, 20) lands on the middle of the tooth's base. A billboard centred on a
 * trench point therefore sits its base *on* the trench line and points the
 * apex away from it — the cartographic convention, where teeth sit on the
 * overriding-plate side.
 *
 * The `casingHex` stroke is the same device the boundary lines use: over blue
 * water the convergent orange alone measures 1.49:1 against the backdrop, so
 * the tooth would smear into the seafloor. The outline gives it an edge that
 * doesn't depend on what's underneath. Geometry is inset by half the stroke
 * width so the casing stays inside the viewBox.
 */
export function toothImageDataUri(colorHex: string, casingHex: string | null): string {
  const stroke =
    casingHex === null ? '' : ` stroke="${casingHex}" stroke-width="2" stroke-linejoin="round"`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="40" viewBox="0 0 20 40">` +
    `<path d="M10 1 L19 20 L1 20 Z" fill="${colorHex}"${stroke}/>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
