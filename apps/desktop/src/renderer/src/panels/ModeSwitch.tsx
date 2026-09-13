import { useAppModeStore, type AppMode } from '../state/useAppModeStore';
import styles from './ModeSwitch.module.css';

/**
 * Explore, Analyze and Waveforms. Top-centre, the one region of the chrome
 * nothing else claims — the left column, right column and scrubber are all
 * already spoken for.
 *
 * Always visible, in every mode — it's how you get back.
 *
 * **List-driven, like `layers/registry.ts` and `panels/track-rows.ts`.** It
 * was two hardcoded buttons; adding a third meant either a third copy of the
 * same markup or this. The switch grows *horizontally* as modes are added
 * (~180px for two, ~270px for three), which still sits comfortably inside
 * `MIN_WIDTH` (1000px, see `main/index.ts`).
 */
const MODES: readonly { id: AppMode; label: string }[] = [
  { id: 'explore', label: 'Explore' },
  { id: 'analyze', label: 'Analyze' },
  { id: 'waveforms', label: 'Waveforms' },
];

export function ModeSwitch() {
  const mode = useAppModeStore((state) => state.mode);
  const setMode = useAppModeStore((state) => state.setMode);

  return (
    <div className={styles.switch} role="tablist" aria-label="App mode">
      {MODES.map((candidate) => (
        <button
          key={candidate.id}
          type="button"
          role="tab"
          aria-selected={mode === candidate.id}
          className={mode === candidate.id ? styles.active : styles.inactive}
          onClick={() => {
            setMode(candidate.id);
          }}
        >
          {candidate.label}
        </button>
      ))}
    </div>
  );
}
