import { compareVersions } from './app-update';

/**
 * The first-run tour: which of its steps a launch should show.
 *
 * Shown in full to a fresh install, never unprompted to an existing user —
 * except for steps an update marks `whatsNew`, which an existing user sees
 * once, on the first launch of the version that added them. The same steps
 * stay in the full tour for everyone installing later, so "what's new" never
 * needs its own copy of the words.
 */

/** What main knows at launch. */
export interface TourStatus {
  /**
   * No "seen through" watermark at startup: the app has never completed a
   * poll on this machine. Captured before the first poll writes one.
   */
  freshInstall: boolean;
  /** The app version whose tour was last finished or skipped, if any. */
  seenVersion: string | null;
  currentVersion: string;
}

/** The parts of a step this decision reads. */
export interface TourStepVersioning {
  /** The app version that added the step, `x.y.z`. */
  addedIn: string;
  /** Shown to existing users on the update that adds it. */
  whatsNew?: boolean;
}

/**
 * The steps this launch shows, in order; empty for no tour.
 *
 * - **Fresh install, never toured:** every step.
 * - **Existing install, never toured:** nothing. These are people who were
 *   using the app before the tour existed; walking them through what they
 *   already use is the annoying kind of tour. The caller records the current
 *   version, so later what's-new steps are measured from here.
 * - **Toured before:** only `whatsNew` steps added after that version.
 *
 * Fails toward showing nothing: a stored version that does not parse, or a
 * step whose own version does not, is not a reason to interrupt anyone.
 */
export function tourStepsToShow<T extends TourStepVersioning>(steps: readonly T[], status: TourStatus): T[] {
  if (status.seenVersion === null) return status.freshInstall ? [...steps] : [];
  const seen = status.seenVersion;
  return steps.filter((step) => step.whatsNew === true && (compareVersions(step.addedIn, seen) ?? 0) > 0);
}

/** Whether to record the current version even though no tour ran. */
export function tourNeedsRecording(status: TourStatus): boolean {
  return status.seenVersion !== status.currentVersion;
}
