import { bearingDeg, intensityNumeral, type QuakeWatchAlert, type QuakeWatchStatus } from '@terra-pulse/schema';
import { compassPoint } from '../waveforms/station-pick';

/**
 * Words for the live watch, kept apart from the components so every case is a
 * test. Two places read them: the dock chip that says the watch is running,
 * and the banner that says a quake is coming.
 */

export type WatchHealth = 'off' | 'running' | 'limited' | 'trouble';

/**
 * The chip's dot. Operational state, so colour is allowed (the dock's stream
 * dot set that precedent):
 * - `running`: data flowing and quakes near the pin are in reach;
 * - `limited`: running, but no station within the detector's search distance
 *   of the pin, so it can catch only quakes near the stations;
 * - `trouble`: not listening right now — unavailable, reconnecting, or no
 *   gains, so no magnitude and therefore no alert.
 */
export function watchHealth(status: QuakeWatchStatus): WatchHealth {
  if (status.state === 'off') return 'off';
  if (status.state === 'unavailable') return 'trouble';
  if (status.state === 'starting') return 'running';
  if (!status.connected && status.retries > 0) return 'trouble';
  if (status.magnitudeStations === 0) return 'trouble';
  if (status.limit !== null) return 'limited';
  return 'running';
}

/** "Watching Burbank · 71/75" — short enough for the dock strip. */
export function watchChipLabel(status: QuakeWatchStatus): string {
  const place = status.pin?.label ?? '';
  switch (status.state) {
    case 'off':
      return '';
    case 'starting':
      return `Watching ${place} · connecting`;
    case 'unavailable':
      return `Watch ${place} · unavailable`;
    case 'watching':
      if (!status.connected) return `Watching ${place} · ${status.retries > 0 ? 'reconnecting' : 'connecting'}`;
      return `Watching ${place} · ${String(status.liveStations)}/${String(status.stations)}`;
  }
}

/**
 * The chip's tooltip: everything the strip has no room for, and above all the
 * limits — what the watch cannot do from here is the part a reader most needs.
 */
export function watchDetail(status: QuakeWatchStatus): string {
  if (status.state === 'off') return '';
  const lines: string[] = [];
  if (status.state === 'unavailable') lines.push(`Not watching: ${status.reason ?? 'unavailable'}.`);
  if (status.state === 'watching') {
    lines.push(
      `${String(status.liveStations)} of ${String(status.stations)} stations delivering; ` +
        `${String(status.magnitudeStations)} can measure magnitude.`,
    );
    if (status.reason !== null) lines.push(`${status.reason}.`);
  }
  if (status.limit === 'too-few-stations') {
    lines.push('Fewer than four public stations within 300 km: the detector cannot declare anything here.');
  } else if (status.limit === 'too-far' && status.nearestKm !== null) {
    lines.push(
      `Nearest station ${String(Math.round(status.nearestKm))} km away: quakes right at the pin are out of reach; ` +
        'only quakes near the stations can be caught.',
    );
  }
  if (status.state === 'watching') {
    lines.push(`Quakes detected since the pin was dropped: ${String(status.detections)}.`);
    lines.push('Alerts: M4.5+ and predicted to be felt at the pin.');
  }
  return lines.join('\n');
}

export interface AlertWords {
  magnitude: string;
  /** "42 km SE of Burbank". */
  where: string;
  /** "Shaking in ~12 s", or past tense once it should have arrived. */
  countdown: string;
  /** Predicted at the pin, e.g. "III". */
  intensity: string;
  /** Whether the shaking is still to come. */
  ahead: boolean;
}

export function alertWords(alert: QuakeWatchAlert, nowMs: number): AlertWords {
  const secondsLeft = (alert.sArrivalAtPinMs - nowMs) / 1000;
  const ahead = secondsLeft > 0.5;
  // From the pin to the epicentre: where the quake is, as seen from the pin.
  const direction = compassPoint(bearingDeg(alert.pin, alert));
  return {
    magnitude: `M${alert.magnitude.toFixed(1)}`,
    where:
      alert.epicentralKm < 10
        ? `at ${alert.pin.label}`
        : `${String(Math.round(alert.epicentralKm))} km ${direction} of ${alert.pin.label}`,
    countdown: ahead ? `Shaking in ~${String(Math.ceil(secondsLeft))} s` : 'Shaking should have arrived',
    intensity: intensityNumeral(alert.intensity),
    ahead,
  };
}
