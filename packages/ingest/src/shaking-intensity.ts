/**
 * Predicted shaking intensity (Modified Mercalli) at a place, from a magnitude
 * and a distance: Atkinson, Worden & Wald (2014), the California form.
 *
 * The early-warning alert is about shaking *at home*, not magnitude: an M4.5
 * 250 km away is barely felt in Burbank, while an M4.0 under it is. ShakeAlert
 * decides the same way — MyShake alerts where expected shaking is MMI III or
 * more (and the phone emergency alerts at MMI IV), not on magnitude alone.
 *
 * ## The equation
 *
 *     MMI = c1 + c2·M + c3·log R + c4·R + c5·B + c6·M·log R
 *     R = √(Dh² + 14²),  B = max(0, log(R / 50))
 *
 * Dh the hypocentral distance in km. Coefficients for California, without site
 * amplification: c1 0.309, c2 1.864, c3 −1.672, c4 −0.00219, c5 1.77,
 * c6 −0.383.
 *
 * **Where they came from, honestly.** The 2014 paper itself was not reachable.
 * The coefficients are from Geoscience Australia's implementation in the
 * OpenQuake framework (`atkinson_2014_ipe.py`, by T. Allen), and the same
 * values appear in Allen's own `mmi_tools.py` — one author, so not independent
 * of each other. The functional form, the 14 km near-source term and the
 * linear-in-magnitude shape match Teng, Baker & Wald (2022, BSSA), who describe
 * AWW14 while evaluating it.
 *
 * **So it was checked against what people actually felt**, which is the better
 * test anyway: USGS "Did You Feel It?" reports from Burbank's ZIP codes for the
 * replay's tuning and reference quakes (2026-10-02). Where Burbank sent many
 * reports the prediction lands on them — Ridgecrest M7.1 4.2 vs 4.2 reported
 * (161 reports), Highland Park M4.4 3.8 vs 3.8 (404), Lamont M5.2 2.8 vs 2.9,
 * Malibu M4.2 2.4 vs 2.6, Ridgecrest M6.4 3.5 vs 3.7, Ojai M5.1 3.0 vs 2.6.
 * Over all 18 quakes with any report: observed − predicted +0.19, sd 0.42. The
 * positive bias comes from quakes with one to five reports, which DYFI is
 * known to skew high on — people who felt nothing rarely write in.
 *
 * Mean prediction only. The sigma is quoted as 0.5 in one transcription and
 * 0.15 in the other, so it is not used for anything.
 */

export const AWW14_CALIFORNIA = {
  c1: 0.309,
  c2: 1.864,
  c3: -1.672,
  c4: -0.00219,
  c5: 1.77,
  c6: -0.383,
  /** Near-source saturation term, km. */
  h: 14,
} as const;

/** MMI (a continuous value; I-X by convention) at a hypocentral distance in km. */
export function predictIntensity(magnitude: number, hypocentralKm: number): number {
  const { c1, c2, c3, c4, c5, c6, h } = AWW14_CALIFORNIA;
  const r = Math.hypot(hypocentralKm, h);
  const logR = Math.log10(r);
  const b = Math.max(0, Math.log10(r / 50));
  return c1 + c2 * magnitude + c3 * logR + c4 * r + c5 * b + c6 * magnitude * logR;
}

// Lives in the schema so the renderer's alert banner names intensity the same
// way; re-exported here so the script and tests keep one import.
export { intensityNumeral } from '@terra-pulse/schema';
