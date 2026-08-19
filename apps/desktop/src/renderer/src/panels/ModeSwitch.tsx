import { useAppModeStore } from '../state/useAppModeStore';
import styles from './ModeSwitch.module.css';

/**
 * Explore vs. Analyze. Top-centre, the one region of the chrome nothing else
 * claims — the left column, right column and scrubber are all already
 * spoken for, and this is small enough (~180px) to sit comfortably above
 * `MIN_WIDTH` (1000px, see `main/index.ts`).
 *
 * Always visible, in both modes — it's how you get back.
 */
export function ModeSwitch() {
  const mode = useAppModeStore((state) => state.mode);
  const setMode = useAppModeStore((state) => state.setMode);

  return (
    <div className={styles.switch} role="tablist" aria-label="App mode">
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'explore'}
        className={mode === 'explore' ? styles.active : styles.inactive}
        onClick={() => {
          setMode('explore');
        }}
      >
        Explore
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'analyze'}
        className={mode === 'analyze' ? styles.active : styles.inactive}
        onClick={() => {
          setMode('analyze');
        }}
      >
        Analyze
      </button>
    </div>
  );
}
