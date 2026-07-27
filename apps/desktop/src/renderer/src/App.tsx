import { useEffect } from 'react';
import { CesiumViewer } from './globe/CesiumViewer';
import { BasemapToggle } from './panels/BasemapToggle';
import { DepthLegend } from './panels/DepthLegend';
import { useEarthquakeStore } from './state/useEarthquakeStore';
import styles from './App.module.css';

export default function App() {
  const load = useEarthquakeStore((state) => state.load);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div id="app-shell" className={styles.appShell}>
      <CesiumViewer />
      <BasemapToggle />
      <DepthLegend />
    </div>
  );
}
