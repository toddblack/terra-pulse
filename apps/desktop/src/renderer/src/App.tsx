import type { ComponentType } from 'react';
import { CesiumViewer } from './globe/CesiumViewer';
import { ExploreShell } from './ExploreShell';
import { AnalyzeShell } from './analyze/AnalyzeShell';
import { WaveformShell } from './waveforms/WaveformShell';
import { ModeSwitch } from './panels/ModeSwitch';
import { useAppModeStore, type AppMode } from './state/useAppModeStore';
import styles from './App.module.css';

/**
 * Explore, Analyze and Waveforms (non-negotiable #1). `mode` decides which
 * shell mounts — **genuinely unmounted, not hidden**, so nothing Explore-side
 * is on screen, subscribed, or polling while another mode is active, nothing
 * Analyze-side exists at all until asked for, and the waveform mode's socket
 * closes the moment you leave it.
 *
 * `CesiumViewer` stays mounted across the switch regardless — there is
 * nothing to destroy (non-negotiable #5 is untouched), and remounting it
 * would re-run every layer's mount/unmount path for no benefit.
 *
 * **An exhaustive record rather than a ternary.** With two modes this was
 * `mode === 'explore' ? … : …`, which quietly treated "not Explore" as
 * Analyze — a third mode would have fallen through to the wrong shell with
 * nothing failing. Keyed by `AppMode`, a fourth is a compile error here.
 */
const SHELLS: Record<AppMode, ComponentType> = {
  explore: ExploreShell,
  analyze: AnalyzeShell,
  waveforms: WaveformShell,
};

export default function App() {
  const mode = useAppModeStore((state) => state.mode);
  const Shell = SHELLS[mode];

  return (
    <div id="app-shell" className={styles.appShell}>
      <CesiumViewer />
      <Shell />
      <ModeSwitch />
    </div>
  );
}
