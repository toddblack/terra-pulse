import { useEffect } from 'react';
import { LargeEventBanner } from './panels/LargeEventBanner';
import { EventListPanel } from './panels/EventListPanel';
import { MissedEventsPanel } from './panels/MissedEventsPanel';
import { LayerPanel } from './panels/LayerPanel';
import { RangeControls } from './panels/RangeControls';
import { FaultProbeToggle } from './panels/FaultProbeToggle';
import { DepthLegend } from './panels/DepthLegend';
import { BottomDock } from './panels/BottomDock';
import { publishSize } from './panels/published-size';
import { EarthquakeInspector } from './panels/EarthquakeInspector';
import { LocationPanel } from './panels/LocationPanel';
import { SolarEventPanel } from './panels/SolarEventPanel';
import { HoverTooltip } from './panels/HoverTooltip';
import { GnssWindow } from './gnss/GnssWindow';
import { pollCanReach, selectEventById, useEarthquakeStore } from './state/useEarthquakeStore';
import { useShakeMapStore } from './state/useShakeMapStore';
import { shakeMapEligible } from '@terra-pulse/schema';
import { playAlertSound } from './audio/alert-sound';
import styles from './App.module.css';
import { useAurora } from './panels/useAurora';
import { useMagnetometers } from './panels/useMagnetometers';
import { useTec } from './panels/useTec';
import { useDonkiStatus } from './panels/useDonkiStatus';
import { LayerGuideModal } from './panels/LayerGuideModal';
import { HistoricalDataPanel } from './panels/HistoricalDataPanel';
import { TourOverlay } from './tour/TourOverlay';
import { useFirstRunTour } from './tour/useFirstRunTour';

/**
 * The side columns' widths, for `BottomDock` to fit between. Measured because
 * both change at runtime — the left with the archive panel, the right with the
 * event list and the legend's sections — and a dock sized by a guess overlaps
 * them. The right column is measured whole, event list included: the list can
 * reach down beside the dock whenever the legend is shorter than it.
 */
const publishLeftColumnWidth = publishSize('--left-column-width', 'width');
const publishRightColumnWidth = publishSize('--right-column-width', 'width');
/** Zero when nothing is selected, and published as zero: the top-centre
 * column slides right by this, and must slide back when the column empties. */
const publishSelectionColumnWidth = publishSize('--selection-column-width', 'width', { publishZero: true });

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
  // Keeps the DONKI archive panel's progress current.
  useDonkiStatus();
  // On a fresh install, once the globe has drawn: the walkthrough.
  useFirstRunTour();

  const load = useEarthquakeStore((state) => state.load);
  const noteSynced = useEarthquakeStore((state) => state.noteSynced);
  const announceLargeEvent = useEarthquakeStore((state) => state.announceLargeEvent);
  const showMissedEvents = useEarthquakeStore((state) => state.showMissedEvents);

  useEffect(() => {
    void load();
  }, [load]);

  // The shaking lines: with the switch on, ask USGS for the selected quake's
  // map whenever the selection lands on one that could have it. Here rather
  // than in the inspector or the viewer because both of those read the answer,
  // and one asker is what keeps it to one request. Keyed on the id, so a
  // catalogue reload (a new event object, the same quake) asks nothing.
  const shakingOn = useShakeMapStore((state) => state.enabled);
  const loadShakeMap = useShakeMapStore((state) => state.load);
  const shakingEventId = useEarthquakeStore((state) => {
    const event = selectEventById(state, state.selectedEventId);
    return event !== null && shakeMapEligible(event) ? event.id : null;
  });
  useEffect(() => {
    if (!shakingOn || shakingEventId === null) return;
    void loadShakeMap(shakingEventId);
  }, [shakingOn, shakingEventId, loadShakeMap]);

  // Main polls USGS on a timer and pushes the result. Only re-query when the
  // catalogue actually changed — a quiet poll just moves the freshness label,
  // because replacing the event set would rebuild the globe layer and destroy
  // whichever event the user currently has open in the inspector.
  useEffect(() => {
    return window.terraPulse.earthquakes.onUpdated((result) => {
      // A date range that ended before the rolling cache began holds nothing
      // a poll can touch, so it is treated as a quiet one. See `pollCanReach`.
      if (result.changed && pollCanReach(useEarthquakeStore.getState().dateRange)) {
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

  // The other half of `onLargeEvent` above, and not redundant with it.
  //
  // Main's first poll fires immediately at launch, while the subscription
  // above is registered in an effect that runs after the renderer bundle and
  // Cesium have loaded — so main wins that race and the launch alert is
  // pushed to nobody. Found by hitting it: the OS notification appeared and
  // the in-app banner did not.
  //
  // That is the alert least worth losing. `ALERT_MAX_AGE_MS` is four hours
  // precisely so that opening the app shortly after a large event still
  // announces it, and opening the app *is* the launch poll.
  //
  // Asking after subscribing means an alert arriving between the two is
  // announced twice — both times with the same event, so `announceLargeEvent`
  // is idempotent and nothing flickers.
  useEffect(() => {
    window.terraPulse.earthquakes
      .currentAlert()
      .then((event) => {
        if (event) announceLargeEvent(event);
      })
      .catch((error: unknown) => {
        console.error('Could not read the current alert', error);
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
      {/* The layer panel is the last child rather than placing itself at
          `bottom: 3rem`, which is where it used to collide with the archive
          above it on a short screen. `margin-top: auto` keeps it at the
          bottom; the archive is what shrinks. See App.module.css. */}
      <div id="left-column" className={styles.leftColumn} ref={publishLeftColumnWidth}>
        <RangeControls />
        <HistoricalDataPanel />
        <FaultProbeToggle />
        <LayerPanel />
      </div>
      {/* Order in the column is reading order, top to bottom: what just
          happened, what you missed, then whatever you clicked. */}
      <div className={styles.topCentreColumn}>
        <LargeEventBanner />
        <MissedEventsPanel />
      </div>
      {/* Everything that was clicked, in one column beside the range controls:
          the quake, then the fault or boundary, then the flare or CME. */}
      <div id="selection-column" className={styles.selectionColumn} ref={publishSelectionColumnWidth}>
        <EarthquakeInspector />
        <LocationPanel />
        <SolarEventPanel />
      </div>
      {/* The timeline and the live waveforms, one at a time, between the two
          columns. Before it existed, waveforms were a mode of their own that
          unmounted all of the above. */}
      <BottomDock />
      <div id="right-column" className={styles.rightColumn} ref={publishRightColumnWidth}>
        <EventListPanel />
        <DepthLegend />
      </div>
      {/* Last, so it draws above every panel — it tracks the pointer and
          must never be occluded by the chrome it passes over. */}
      {/* Floating, outside the columns: it is dragged wherever it is least in
          the way. */}
      <GnssWindow />
      <HoverTooltip />
      <LayerGuideModal />
      {/* Last of all: it dims everything above and lifts one piece out. */}
      <TourOverlay />
    </>
  );
}
