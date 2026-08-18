import { useEffect, useRef, useState } from 'react';
import { useGlobeStore } from '../state/useGlobeStore';
import styles from './DonkiKeyModal.module.css';

/**
 * Gates solar flares, CME arrivals and the full event-history download
 * behind a personal DONKI API key.
 *
 * **There is no "proceed on the shared key" option**, by product choice —
 * headroom (2,500 requests/hour instead of 10) and not depending on a
 * resource shared with every DONKI tutorial that hardcodes `DEMO_KEY`. (An
 * earlier version of this comment claimed the shared key had been *proven*
 * unreliable; it hadn't been — every 403 seen while building this was
 * actually a blank `NASA_DONKI_API_KEY=` in `.env` being sent as the key
 * instead of being treated as unset. See `donkiApiKey` in
 * `apps/desktop/src/main/ipc/nasa-donki.ts`.)
 *
 * Opens from two places — the archive panel's Download/Resume button, and
 * turning on the solar-flares or CME-arrivals layer with no key configured —
 * via `donkiKeyModalTrigger` in the store, which is why it lives here rather
 * than as local state in one panel (same reasoning as `LayerGuideModal`,
 * which the shell below mirrors: backdrop swallows pointer events for the
 * same Cesium `MOUSE_MOVE` reason — hover picking and drag-deselect both run
 * off it, and letting events through would leave tooltips and clearable
 * selections underneath the dialog — Escape closes, click-outside closes,
 * focus moves in).
 *
 * Never receives or displays an existing key's value — only `hasApiKey`
 * crosses IPC for that, so there is nothing to mask; the input always starts
 * empty.
 */
export function DonkiKeyModal() {
  const trigger = useGlobeStore((state) => state.donkiKeyModalTrigger);
  const closeDonkiKeyModal = useGlobeStore((state) => state.closeDonkiKeyModal);
  const setLayerVisible = useGlobeStore((state) => state.setLayerVisible);
  const setDonkiProgress = useGlobeStore((state) => state.setDonkiProgress);

  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Fresh form state each time a *new* trigger opens the modal — the
  // component stays mounted while closed (it renders null rather than
  // unmounting), so local state would otherwise carry an error or partial
  // input over into a later, unrelated open. Reset during render rather than
  // in an effect: React's documented pattern for state that depends on a
  // prop changing (react.dev/learn/you-might-not-need-an-effect), and it
  // skips the extra render an effect-based reset would cost.
  const [resetForTrigger, setResetForTrigger] = useState(trigger);
  if (trigger !== resetForTrigger) {
    setResetForTrigger(trigger);
    setKey('');
    setSaving(false);
    setError(null);
  }

  useEffect(() => {
    if (trigger === null) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeDonkiKeyModal();
    };
    window.addEventListener('keydown', onKeyDown);
    inputRef.current?.focus();

    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [trigger, closeDonkiKeyModal]);

  if (trigger === null) return null;

  const proceed = () => {
    closeDonkiKeyModal();
    if (trigger.kind === 'download') {
      void window.terraPulse.solarEvents.start();
    } else {
      setLayerVisible(trigger.layerId, true);
    }
  };

  const save = () => {
    const trimmed = key.trim();
    if (trimmed.length === 0) return;
    setSaving(true);
    setError(null);
    void window.terraPulse.solarEvents.saveApiKey(trimmed).then(
      (updated) => {
        // Without this, `hasApiKey` stays stale in the store until the next
        // real backfill event happens to publish one — which for the
        // 'enable-layer' trigger never happens on its own, since that path
        // never calls start(). Found in the field: saved a key from the
        // layer toggle, then Resume and the other layer's toggle both still
        // showed the modal.
        setDonkiProgress(updated);
        proceed();
      },
      (caught: unknown) => {
        setSaving(false);
        setError(caught instanceof Error ? caught.message : String(caught));
      },
    );
  };

  return (
    <div className={styles.backdrop} onClick={closeDonkiKeyModal} role="presentation">
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="NASA DONKI API key"
        tabIndex={-1}
        ref={dialogRef}
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <header className={styles.header}>
          <h2 className={styles.title}>Get a free NASA key</h2>
          <button
            type="button"
            className={styles.closeButton}
            onClick={closeDonkiKeyModal}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <p className={styles.body}>
          Solar flares, CME arrivals and the full event-history download need a personal NASA
          DONKI API key. It’s free and instant — no account, just an email address — and NASA’s
          shared key isn’t reliable enough for this app to depend on.
        </p>

        <button
          type="button"
          className={styles.getKeyButton}
          onClick={() => {
            void window.terraPulse.shell.openExternal('https://api.nasa.gov/');
          }}
        >
          Get a key ↗
        </button>

        <div className={styles.keyRow}>
          <input
            ref={inputRef}
            type="text"
            className={styles.input}
            placeholder="Paste your key"
            value={key}
            onChange={(event) => {
              setKey(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') save();
            }}
          />
          <button
            type="button"
            className={styles.saveButton}
            disabled={key.trim().length === 0 || saving}
            onClick={save}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
        {error && <p className={styles.error}>{error}</p>}
      </div>
    </div>
  );
}
