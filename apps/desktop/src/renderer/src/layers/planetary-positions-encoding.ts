import type { CelestialBodyId } from './planetary-positions';

/**
 * Name + colour per body. Colours come from the `dataviz` skill's validated
 * eight-hue categorical palette (dark-mode steps), kept in its documented
 * order — the order itself is the CVD-safety mechanism, not cosmetic, so
 * bodies are assigned to slots 1-8 in sequence rather than reshuffled to
 * chase a "realistic" association (Mars is not actually assigned red, for
 * instance). Validated with `validate_palette.js` against this app's own
 * panel surface (`#0f172a`, not the skill's generic default): all eight
 * clear the lightness band, chroma floor, adjacent-pair CVD separation
 * (worst 8.4, target >= 8) and the normal-vision floor (worst 19.3, floor
 * >= 15).
 *
 * **What this does not claim.** The skill's own reference palette caps at
 * three slots under `--pairs all` (any two marks can be neighbours, which is
 * this layer's actual situation — nine dots free to land anywhere on the
 * globe, not a fixed bar/line sequence) — "no ordering of the full eight can
 * pass" that stricter gate, by the skill's own measurement. Nine categorical
 * marks that are mutually distinguishable by hue alone, anywhere on a
 * sphere, is not achievable at this palette's floor. The mitigation the
 * skill itself sanctions for exactly this case is secondary encoding: every
 * marker here carries a name in both the hover tooltip and the legend
 * (`DepthLegend.tsx`'s `PlanetaryPositionsKey`), so identity is never
 * colour-alone.
 *
 * The Moon is a deliberate ninth, **outside** the eight-hue system — plain
 * neutral grey, which the validator correctly flags as "reads as gray" (it
 * is meant to: an achromatic colour cannot collide with a saturated one on
 * the hue channel, which is a stronger separation from all eight planets
 * than adding a ninth hue could achieve).
 *
 * **The Moon's grey is a mid-tone, not a light one — found by measurement,
 * not eyeballing, after a real miss.** The first pick (`#cbd5e1`, a pale
 * slate) validated fine against this app's own dark panel surface (11-12:1
 * contrast) and was nearly invisible on the "Basic" (OSM) globe basemap —
 * 1.3-1.5:1 against typical light-tile colours, reported by the user. Marker
 * fills here get no basemap-tone adaptation (unlike the raster layers), so
 * one hex has to read against a light basemap, two dark ones, and the dark
 * legend panel all at once — the fix was the same one `UNKNOWN_DEPTH_COLOR`
 * already used for exactly this problem: a genuine *mid*-tone clears
 * reasonable contrast on both ends at once (measured: `#6b7280` gives
 * ~4.2-4.8:1 against representative light-basemap colours and ~3.5-3.7:1
 * against the dark panel and relief's near-black ocean), where a pale or a
 * near-black grey can only ever win on one side.
 */
export const CELESTIAL_BODY_NAMES: Record<CelestialBodyId, string> = {
  sun: 'Sun',
  mercury: 'Mercury',
  venus: 'Venus',
  mars: 'Mars',
  jupiter: 'Jupiter',
  saturn: 'Saturn',
  uranus: 'Uranus',
  neptune: 'Neptune',
  moon: 'Moon',
};

export const CELESTIAL_BODY_COLORS: Record<CelestialBodyId, string> = {
  sun: '#3987e5',
  mercury: '#d95926',
  venus: '#199e70',
  mars: '#c98500',
  jupiter: '#d55181',
  saturn: '#008300',
  uranus: '#9085e9',
  neptune: '#e66767',
  moon: '#6b7280',
};

/** Display order for the legend and for iterating a fixed nine — Sun and
 * Moon first (the two "local" bodies, and the only ones `tides.ts` already
 * computes), then the seven planets in orbital order. */
export const CELESTIAL_BODY_ORDER: readonly CelestialBodyId[] = [
  'sun',
  'moon',
  'mercury',
  'venus',
  'mars',
  'jupiter',
  'saturn',
  'uranus',
  'neptune',
];
