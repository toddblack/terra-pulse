import type { FaultRecord } from './fault-association';
import raw from '../data/active-faults.json';

/**
 * The vendored GEM active-fault dataset, typed once.
 *
 * ## Why this module exists rather than three direct JSON imports
 *
 * TypeScript infers a literal type for an imported JSON module — every object
 * shape, every array length. That was survivable while the file was homogeneous
 * `{z, p}` records. Adding the four attribute columns made the shapes
 * heterogeneous (a fault may have any subset of name, slip rate, bounds, type,
 * catalogue) and pushed the file to 3.16 MB, at which point the inferred type
 * stops resolving: `tsc --noEmit` still passes, but the type-aware lint rules
 * see an unresolvable type and every property read becomes an
 * `no-unsafe-member-access` error.
 *
 * Asserting the shape once here means nothing downstream ever needs the
 * inferred type. It also puts the *declared* contract in one place next to the
 * script that writes the file, so a vendor-script change that breaks the shape
 * has one place to be fixed rather than three.
 *
 * The assertion goes through `unknown` deliberately: the inferred type is not
 * something a direct assertion can be checked against, so pretending otherwise
 * would just move the error. What guarantees the shape is
 * `scripts/vendor-gem-faults.mjs`, and `fault-association.test.ts` exercises the
 * reader against the same contract.
 *
 * It lives in `layers/` rather than beside the JSON because `data/` is
 * **gitignored** — everything in there is script-derived and regenerated, as its
 * README states. This file is source, and putting it there would have meant it
 * silently never got committed.
 */
export const ACTIVE_FAULTS = raw as unknown as FaultRecord[];

/**
 * The credit CC BY-SA 4.0 requires wherever this data is shown — the legend
 * while the fault layer is on, and the nearest-fault panel, which reads the
 * data with the layer off. One string so the two cannot drift.
 *
 * **"simplified" is a licence term, not modesty.** CC BY-SA 4.0 §3(a)(1)(B)
 * requires indicating that the material was modified, and the shipped file is:
 * 4 of GEM's ~23 columns, long chords densified (see `data/README.md`).
 *
 * The licence name uses no-break spaces and a no-break hyphen: at the panel's
 * width it otherwise wrapped as "CC BY-" / "SA 4.0".
 */
export const GEM_FAULTS_CREDIT =
  'Faults: GEM Global Active Faults · Styron & Pagani (2020) · simplified · CC BY‑SA 4.0';
