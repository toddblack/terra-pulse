import { useEffect } from 'react';
import { CesiumViewer } from './globe/CesiumViewer';
import { LayerPanel } from './panels/LayerPanel';
import { RangeControls } from './panels/RangeControls';
import { DepthLegend } from './panels/DepthLegend';
import { TimeScrubber } from './panels/TimeScrubber';
import { EarthquakeInspector } from './panels/EarthquakeInspector';
import { useEarthquakeStore } from './state/useEarthquakeStore';
import styles from './App.module.css';

export default function App() {
  const load = useEarthquakeStore((state) => state.load);
  const noteSynced = useEarthquakeStore((state) => state.noteSynced);

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

  return (
    <div id="app-shell" className={styles.appShell}>
      <CesiumViewer />
      <RangeControls />
      <LayerPanel />
      <TimeScrubber />
      <DepthLegend />
      <EarthquakeInspector />
    </div>
  );
}
