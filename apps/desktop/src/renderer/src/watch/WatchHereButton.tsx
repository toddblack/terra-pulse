import { isWatching, useQuakeWatchStore } from './useQuakeWatchStore';

/**
 * Drops the live watch's pin on a spot — from the location panel (a clicked
 * fault, boundary or probed point) and the quake inspector (its epicentre).
 * One pin only, so on a second spot it *moves* the watch, and says so.
 *
 * Takes the host panel's own button class, so it reads as one of that panel's
 * actions rather than a foreign control.
 */
export function WatchHereButton({
  point,
  label,
  className,
  activeClassName,
}: {
  point: { latitude: number; longitude: number };
  /** Names the pin in the dock chip and in alerts. */
  label: string;
  /** CSS-module classes, which this codebase types as possibly undefined. */
  className: string | undefined;
  activeClassName: string | undefined;
}) {
  const status = useQuakeWatchStore((state) => state.status);
  const watch = useQuakeWatchStore((state) => state.watch);
  const stopWatching = useQuakeWatchStore((state) => state.stopWatching);
  const error = useQuakeWatchStore((state) => state.error);
  const here = isWatching(status, point);

  if (here) {
    return (
      <button
        type="button"
        id="watch-here"
        aria-pressed
        className={[className, activeClassName].filter(Boolean).join(' ')}
        title="The live watch is on this spot. Click to stop watching."
        onClick={stopWatching}
      >
        Watching · stop
      </button>
    );
  }
  return (
    <button
      type="button"
      id="watch-here"
      aria-pressed={false}
      className={className}
      title={
        error !== null
          ? `Could not start the watch: ${error}`
          : 'Stream the seismometers around this spot while the app is open, and alert on an M4.5+ quake predicted to be felt here'
      }
      onClick={() => {
        watch({ latitude: point.latitude, longitude: point.longitude, label });
      }}
    >
      {status.pin === null ? 'Watch here' : 'Move watch here'}
    </button>
  );
}
