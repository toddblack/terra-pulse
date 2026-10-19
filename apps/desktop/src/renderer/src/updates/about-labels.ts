import type { UpdateStatus } from '@terra-pulse/schema';
import { formatAgoFrom } from '../panels/time-labels';

/**
 * The About panel's words, kept pure so every state has a test.
 *
 * Each line says what is known and stops: "up to date" carries when it was
 * last true, a failure says why, and "off" does not pretend to know anything.
 */
export function updateSummary(status: UpdateStatus, nowMs: number): string {
  const checked = formatAgoFrom(status.checkedAtUtc, nowMs);
  const when = checked === null ? '' : ` · checked ${checked}`;
  switch (status.state) {
    case 'store':
      return 'Updates come through the Microsoft Store.';
    case 'off':
      return 'Update check is off.';
    case 'not-checked':
      return 'Not checked yet.';
    case 'checking':
      return 'Checking…';
    case 'up-to-date':
      return status.detail === null ? `Up to date${when}` : `${status.detail.replace(/\.$/, '')}${when}`;
    case 'available':
      return status.latest === null
        ? `A newer version is available${when}`
        : `Terra Pulse ${status.latest.version} is available${when}`;
    case 'failed':
      return `Could not check: ${(status.detail ?? 'unknown reason').replace(/\.$/, '')}${when}`;
  }
}

/** The label in the mode switch: the version, or a prompt when a newer one waits. */
export function versionLabel(status: UpdateStatus, noticeShowing: boolean): string {
  return noticeShowing ? 'Update' : `v${status.currentVersion}`;
}
