import type { BackdropTone } from '@terra-pulse/schema';

/**
 * How a plate boundary behaves. Bird (2003) classifies boundaries into seven
 * step classes; these are the three kinematic behaviours they collapse to:
 *
 *   convergent  SUB (subduction) · OCB (oceanic) · CCB (continental)
 *   divergent   OSR (spreading ridge) · CRB (continental rift)
 *   transform   OTF (oceanic) · CTF (continental)
 *
 * Three rather than seven is a legibility decision with a measurement behind
 * it: the palette validator passes three categorical colours on the all-pairs
 * test and cannot pass seven. The finer classes remain in the vendored data.
 */
export type KinematicGroup = 'convergent' | 'divergent' | 'transform';

export const KINEMATIC_GROUPS: readonly KinematicGroup[] = [
  'convergent',
  'divergent',
  'transform',
];

/**
 * Validated with the dataviz palette script against both basemap surfaces
 * (`--pairs all`): worst CVD ΔE 9.2 light / 9.4 dark, above the 8 target;
 * normal-vision floor 27.6 / 24.6.
 *
 * Blue is deliberately absent — it's spent on the earthquake depth ramp, and
 * reusing it would make boundaries and events confusable.
 */
const GROUP_COLORS: Record<BackdropTone, Record<KinematicGroup, string>> = {
  light: {
    convergent: '#eb6834',
    divergent: '#1baf7a',
    transform: '#4a3aa7',
  },
  dark: {
    convergent: '#d95926',
    divergent: '#199e70',
    transform: '#9085e9',
  },
};

export function kinematicColorHex(group: KinematicGroup, tone: BackdropTone): string {
  return GROUP_COLORS[tone][group];
}

/** Human labels for the legend. */
export const KINEMATIC_LABELS: Record<KinematicGroup, string> = {
  convergent: 'convergent',
  divergent: 'divergent',
  transform: 'transform',
};

/**
 * Convergent margins draw heaviest — that's where great earthquakes happen,
 * which is what this app is looking at.
 *
 * This is the *core* width. Total drawn width adds the casing on both sides —
 * see `kinematicTotalLineWidth`.
 */
export function kinematicLineWidth(group: KinematicGroup): number {
  return group === 'convergent' ? 2.5 : 1.5;
}

/**
 * The casing drawn around every boundary line, and why it exists.
 *
 * The colours above are mutually distinguishable, but that was validated
 * against a near-black surface, back when the only dark basemap was Blue
 * Marble. The GEBCO seafloor basemap is *blue water*, and against it all three
 * measured **below 3:1** — 1.49, 1.70, 1.85 on the Mid-Atlantic Ridge, and a
 * hopeless 1.01, 1.15, 1.25 over the shallower ridge crest. Divergent and
 * transform boundaries disappeared exactly where they matter most.
 *
 * A casing fixes this at the root rather than by re-picking hues. The line's
 * *inner* edge — colour against casing — is 5.1:1 to 6.3:1 and does not depend
 * on the backdrop at all, so the line always contains its own contrast edge.
 * Over pale water the casing carries it (5.04:1 on the ridge crest); over deep
 * water the colour does. This is the same reasoning as the earthquake mark
 * halo in `earthquake-encoding.ts`: figure-ground is decoupled from the job of
 * carrying meaning, so hue is free to stay categorical.
 *
 * **Only the dark tone gets one, and that's a measured limit rather than an
 * oversight.** The dark palette clears the bar easily against a near-black
 * casing — 5.07:1, 5.78:1, 6.30:1. The light palette cannot clear 3:1 against
 * *any* single casing, because it spans lightness: transform `#4a3aa7` is dark
 * (8.56:1 vs white) while divergent `#1baf7a` is mid (2.82:1). White fails on
 * the green, black fails on the violet.
 *
 * That turns out to be fine, because the two tones have different problems.
 * "Dark" now means imagery — Relief and Seafloor — whose backdrop varies from
 * pale ridge crest to deep navy, so a line needs an edge of its own. "Light"
 * means the OSM basemap: one consistent pale surface, which is exactly what
 * the light palette was validated against. Adding a casing there would fix
 * nothing and fail its own check. If Basic ever proves hard to read, the fix
 * is re-picking that palette, not casing it.
 */
const CASING_COLORS: Record<BackdropTone, string | null> = {
  light: null,
  dark: '#0b0b0b',
};

/** The casing colour for a tone, or `null` where no casing is drawn. */
export function kinematicCasingColorHex(tone: BackdropTone): string | null {
  return CASING_COLORS[tone];
}

/** Casing thickness, total across both sides. */
export const KINEMATIC_CASING_WIDTH = 2;

/** Core width plus the casing — what Cesium wants as the polyline `width`. */
export function kinematicTotalLineWidth(group: KinematicGroup): number {
  return kinematicLineWidth(group) + KINEMATIC_CASING_WIDTH;
}

export function isKinematicGroup(value: unknown): value is KinematicGroup {
  return value === 'convergent' || value === 'divergent' || value === 'transform';
}
