import { useEffect, useRef, useState } from 'react';
import { updateNoticeShowing } from '@terra-pulse/schema';
import { useNow } from '../globe/useNow';
import { updateSummary, versionLabel } from './about-labels';
import { useUpdateStore } from './useUpdateStore';
import styles from './AboutButton.module.css';

/**
 * The version, in the lower-right corner under the legend, and the panel
 * behind it.
 *
 * **Not in the mode switch**: it was there first and the user moved it — a
 * version number crammed in with the navigation reads as navigation. The
 * corner is the 3rem strip both side columns leave clear at the bottom; the
 * Cesium credits that strip protects run along the bottom-*left* only
 * (measured: x 5-453 px on a 1584 px window), so the right end is free.
 * Mounted in `App`, so it shows in Analyze too.
 *
 * It is the update check's only surface: the label reads "Update" with a dot
 * when a newer release waits, and the panel holds the switch that turns the
 * check off. There is no settings screen, and a switch that only lived on an
 * update notice could never be turned back on.
 *
 * **The dot is colour, on purpose.** Status indicators may carry hue here
 * (the Analyze tab dots); significance and disclosure state may not.
 */
export function AboutButton() {
  const status = useUpdateStore((state) => state.status);
  const check = useUpdateStore((state) => state.check);
  const setEnabled = useUpdateStore((state) => state.setEnabled);
  const dismiss = useUpdateStore((state) => state.dismiss);
  const openRelease = useUpdateStore((state) => state.openRelease);
  const nowMs = useNow();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointer);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  if (status === null) return null;
  const notice = updateNoticeShowing(status);
  const latest = status.latest;

  return (
    <div ref={rootRef} className={styles.root}>
      <button
        id="about-button"
        type="button"
        className={notice ? styles.labelNotice : styles.label}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={notice && latest ? `Terra Pulse ${latest.version} is available` : `Terra Pulse ${status.currentVersion}`}
        onClick={() => {
          setOpen((was) => !was);
        }}
      >
        {notice && <span className={styles.dot} aria-hidden="true" />}
        {versionLabel(status, notice)}
      </button>

      {open && (
        <div id="about-panel" className={styles.panel} role="dialog" aria-label="About Terra Pulse">
          <div className={styles.title}>Terra Pulse {status.currentVersion}</div>
          <div className={styles.summary} aria-live="polite">
            {updateSummary(status, nowMs)}
          </div>

          {status.state === 'available' && latest && (
            <div className={styles.actions}>
              <button type="button" className={styles.primary} onClick={openRelease}>
                Get {latest.version}
              </button>
              {latest.version !== status.dismissedVersion && (
                <button
                  type="button"
                  className={styles.secondary}
                  onClick={() => {
                    dismiss(latest.version);
                  }}
                >
                  Not now
                </button>
              )}
            </div>
          )}

          <div className={styles.actions}>
            <button
              type="button"
              className={styles.secondary}
              disabled={!status.enabled || status.state === 'checking'}
              onClick={check}
            >
              Check now
            </button>
          </div>

          <label className={styles.toggle}>
            <input
              type="checkbox"
              checked={status.enabled}
              onChange={(event) => {
                setEnabled(event.target.checked);
              }}
            />
            Check for updates
          </label>
          <p className={styles.note}>
            Asks GitHub once at launch and once a day while open; GitHub sees your IP address. Nothing is
            downloaded or installed — a newer version is a link to its release page.
          </p>
        </div>
      )}
    </div>
  );
}
