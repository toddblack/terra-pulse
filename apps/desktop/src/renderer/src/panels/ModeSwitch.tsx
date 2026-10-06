import { useAppModeStore, type AppMode } from '../state/useAppModeStore';
import styles from './ModeSwitch.module.css';

/**
 * Explore and Analyze. Top-centre, the one region of the chrome nothing else
 * claims — the left column, right column and bottom dock are all already
 * spoken for.
 *
 * Always visible, in every mode — it's how you get back.
 *
 * **List-driven, like `layers/registry.ts` and `panels/track-rows.ts`.** It
 * held three modes for a while; Waveforms became a tab in Explore's bottom
 * dock instead, which is why there are two again. The switch grows
 * *horizontally* as modes are added (~180px for two, ~270px for three), well
 * inside `MIN_WIDTH` (1000px, see `main/index.ts`).
 */
const MODES: readonly { id: AppMode; label: string }[] = [
  { id: 'explore', label: 'Explore' },
  { id: 'analyze', label: 'Analyze' },
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
