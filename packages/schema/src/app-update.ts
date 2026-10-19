/**
 * The update check: does GitHub have a newer release than the one running?
 *
 * **Notify only, by decision** (2026-10-19). The app tells the reader a newer
 * version exists and links to its release page; it never downloads or
 * installs anything. Full auto-update is the goal once builds are signed:
 * unsigned, the updater's integrity check comes from the same release as the
 * installer, so whoever controlled the GitHub account could push to every
 * install unseen. A notice adds no such path.
 *
 * Main asks; these are the shapes that cross the bridge and the pure rules
 * both sides read.
 */

/** A published release, as far as the notice needs to know it. */
export interface ReleaseInfo {
  /** `0.2.0` — the tag without its `v`. */
  version: string;
  /** The release's page on GitHub. Validated in main before it is kept. */
  url: string;
  publishedUtc: string | null;
}

export type UpdateCheckState =
  /** The reader switched the check off. Nothing is asked. */
  | 'off'
  /** On, but no check has run yet this session (dev builds wait to be asked). */
  | 'not-checked'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'failed';

export interface UpdateStatus {
  /** The running app's version. */
  currentVersion: string;
  enabled: boolean;
  state: UpdateCheckState;
  /** The newest published release, when the last check found one. */
  latest: ReleaseInfo | null;
  checkedAtUtc: string | null;
  /** A version the reader dismissed; its notice stays quiet, a newer one does not. */
  dismissedVersion: string | null;
  /** One line for the About panel: why a check failed, or "no release yet". */
  detail: string | null;
}

/**
 * `1.2.3` or `v1.2.3` as three numbers, or null.
 *
 * Strict on purpose: the tag comes off the network, and a lenient parse
 * (`1.2`, `1.2.3-beta`, `1.2.3.4`) would make "newer" mean something nobody
 * decided. Pre-releases are excluded upstream anyway — GitHub's "latest"
 * endpoint never returns one.
 */
export function parseVersion(text: string): [number, number, number] | null {
  const match = /^v?(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.exec(text.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Negative if `a` is older, 0 if equal, positive if newer; null if either does not parse. */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) return null;
  for (let i = 0; i < 3; i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Whether the version label should call attention to a newer release. */
export function updateNoticeShowing(status: UpdateStatus): boolean {
  return status.state === 'available' && status.latest !== null && status.latest.version !== status.dismissedVersion;
}
