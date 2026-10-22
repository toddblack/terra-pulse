import { useEffect } from 'react';
import { tourNeedsRecording, tourStepsToShow } from '@terra-pulse/schema';
import { useEarthquakeStore } from '../state/useEarthquakeStore';
import { useGlobeStore } from '../state/useGlobeStore';
import { TOUR_STEPS } from './tour-steps';
import { useTourStore } from './useTourStore';

/** Pause after the globe draws and quakes arrive, so the panels have settled. */
const SETTLE_MS = 600;
/**
 * The longest the tour waits for quakes after the globe has drawn. On a fresh
 * install the catalogue is being fetched as the app opens, and a welcome that
 * says "every dot is an earthquake" over a globe with none reads as broken —
 * but offline, nothing will ever arrive, and the tour should not wait forever.
 */
const CATALOGUE_WAIT_MS = 8_000;

/**
 * Asked once per launch, not once per `ExploreShell` mount: switching to
 * Analyze and back must not re-ask. After the tour ends main has recorded it,
 * so a second ask would find nothing to show anyway — this saves the round
 * trip and any chance of a race with a tour still on screen.
 */
let askedThisLaunch = false;

/** Starts the tour on a fresh install, or the what's-new steps after an update. */
export function useFirstRunTour(): void {
  const globePainted = useGlobeStore((state) => state.globePainted);
  const hasQuakes = useEarthquakeStore((state) => state.events.length > 0);
  const start = useTourStore((state) => state.start);

  useEffect(() => {
    if (!globePainted || askedThisLaunch) return;
    const timer = setTimeout(
      () => {
        askedThisLaunch = true;
        window.terraPulse.tour
          .status()
          .then((status) => {
            const steps = tourStepsToShow(TOUR_STEPS, status);
            if (steps.length > 0) start(steps);
            else if (tourNeedsRecording(status)) return window.terraPulse.tour.markSeen();
            return undefined;
          })
          .catch((error: unknown) => {
            console.error('Could not check the first-run tour', error);
          });
      },
      hasQuakes ? SETTLE_MS : CATALOGUE_WAIT_MS,
    );
    return () => {
      clearTimeout(timer);
    };
  }, [globePainted, hasQuakes, start]);
}
