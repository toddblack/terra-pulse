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
 */
export function kinematicLineWidth(group: KinematicGroup): number {
  return group === 'convergent' ? 2.5 : 1.5;
}

export function isKinematicGroup(value: unknown): value is KinematicGroup {
  return value === 'convergent' || value === 'divergent' || value === 'transform';
}
