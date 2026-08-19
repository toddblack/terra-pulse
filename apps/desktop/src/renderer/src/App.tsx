import { CesiumViewer } from './globe/CesiumViewer';
import { ExploreShell } from './ExploreShell';
import { AnalyzeShell } from './analyze/AnalyzeShell';
import { ModeSwitch } from './panels/ModeSwitch';
import { useAppModeStore } from './state/useAppModeStore';
import styles from './App.module.css';

/**
 * Explore and Analyze (non-negotiable #1). `mode` decides which shell
 * mounts — **genuinely unmounted, not hidden**, so nothing Explore-side is
 * on screen, subscribed, or polling while Analyze is active, and nothing
 * Analyze-side exists at all until asked for. See `useAppModeStore.ts` and
 * `analyze/explore-purity.test.ts` for the rest of how that separation is
 * enforced structurally rather than by convention.
 *
 * `CesiumViewer` stays mounted across the switch regardless — there is
 * nothing to destroy (non-negotiable #5 is untouched), and remounting it
 * would re-run every layer's mount/unmount path for no benefit.
 */
export default function App() {
  const mode = useAppModeStore((state) => state.mode);

  return (
    <div id="app-shell" className={styles.appShell}>
      <CesiumViewer />
      {mode === 'explore' ? <ExploreShell /> : <AnalyzeShell />}
      <ModeSwitch />
    </div>
  );
}
