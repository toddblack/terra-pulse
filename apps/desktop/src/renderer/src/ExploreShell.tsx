import { useEffect } from 'react';
import { LargeEventBanner } from './panels/LargeEventBanner';
import { EventListPanel } from './panels/EventListPanel';
import { MissedEventsPanel } from './panels/MissedEventsPanel';
import { LayerPanel } from './panels/LayerPanel';
import { RangeControls } from './panels/RangeControls';
import { FaultProbeToggle } from './panels/FaultProbeToggle';
import { DepthLegend } from './panels/DepthLegend';
import { TimeScrubber } from './panels/TimeScrubber';
import { EarthquakeInspector } from './panels/EarthquakeInspector';
import { LocationPanel } from './panels/LocationPanel';
import { SolarEventPanel } from './panels/SolarEventPanel';
import { HoverTooltip } from './panels/HoverTooltip';
import { useEarthquakeStore } from './state/useEarthquakeStore';
import { playAlertSound } from './audio/alert-sound';
import styles from './App.module.css';
import { useAurora } from './panels/useAurora';
import { useMagnetometers } from './panels/useMagnetometers';
import { useTec } from './panels/useTec';
import { useDonkiStatus } from './panels/useDonkiStatus';
import { LayerGuideModal } from './panels/LayerGuideModal';
import { DonkiKeyModal } from './panels/DonkiKeyModal';
import { HistoricalDataPanel } from './panels/HistoricalDataPanel';

/**
 * Everything that isn't the globe itself or the Explore/Analyze switch.
 *
 * Split out of `App.tsx` when Analyze mode arrived (§Phase 4). `App.tsx`
 * mounts this component only while `mode === 'explore'` — genuinely
 * unmounted, not hidden, when Analyze is active, so nothing Explore-side
 * (including its live pollers below) is running or on screen. See
 * `App.tsx`'s own comment for why that's structural, not incidental.
 */
export function ExploreShell() {
  // Keeps the live auroral grid current for the layer and its legend.
  useAurora();
  useMagnetometers();
  useTec();
  // Keeps hasApiKey current for both the archive panel and the layer toggles.
  useDonkiStatus();

  const load = useEarthquakeStore((state) => state.load);
  const noteSynced = useEarthquakeStore((state) => state.noteSynced);
  const announceLargeEvent = useEarthquakeStore((state) => state.announceLargeEvent);
  const showMissedEvents = useEarthquakeStore((state) => state.showMissedEvents);

  useEffect(() => {
    void load();
  }, [load]);

  // Main polls USGS on a timer and pushes the result. Only re-query when the
  // catalogue actually changed — a quiet poll just moves the freshness label,
  // because replacing the event set would rebuild the globe layer and destroy
  // whichever event the user currently has open in the inspector.
  useEffect(() => {
    return window.terraPulse.earthquakes.onUpdated((result) => {
      if (result.changed) {
        void load();
      } else {
        noteSynced(result.syncedAt);
      }
    });
  }, [load, noteSynced]);

  // Large events arrive on their own channel rather than being derived from the
  // event set — main decides what qualifies, from what a poll actually fetched,
  // so the launch backfill can't announce a month of old news (PROJECT_PLAN §5.8).
  useEffect(() => {
    return window.terraPulse.earthquakes.onLargeEvent((event) => {
      announceLargeEvent(event);
      // Only on a live arrival. The launch digest is deliberately silent — it
      // reports things that already happened, and a chime for old news on
      // every startup would be noise.
      playAlertSound();
    });
  }, [announceLargeEvent]);

  // Asked for once on mount. Main fixed this value at startup, before the
  // first poll moved the seen-through watermark, so it is safe to request
  // whenever the renderer happens to be ready.
  useEffect(() => {
    window.terraPulse.earthquakes
      .missed()
      .then((missed) => {
        if (missed) showMissedEvents(missed);
      })
      .catch((error: unknown) => {
        console.error('Could not read the launch digest', error);
      });
  }, [showMissedEvents]);

  return (
    <>
      <div className={styles.leftColumn}>
        <RangeControls />
        <HistoricalDataPanel />
        <FaultProbeToggle />
      </div>
      <LargeEventBanner />
      <MissedEventsPanel />
      <LayerPanel />
      <TimeScrubber />
      <div className={styles.rightColumn}>
        <EventListPanel />
        <DepthLegend />
      </div>
      <EarthquakeInspector />
      <LocationPanel />
      <SolarEventPanel />
      {/* Last, so it draws above every panel — it tracks the pointer and
          must never be occluded by the chrome it passes over. */}
      <HoverTooltip />
      <LayerGuideModal />
      <DonkiKeyModal />
    </>
  );
}
