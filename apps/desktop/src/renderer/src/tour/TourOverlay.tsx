import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEarthquakeStore } from '../state/useEarthquakeStore';
import { useEarthquakesUpToPlayhead } from '../globe/useVisibleEarthquakes';
import { placeCard, type Box } from './tour-layout';
import { useTourStore } from './useTourStore';
import styles from './TourOverlay.module.css';

/** How often the target and the card are re-measured while a step shows. */
const MEASURE_MS = 200;
/** How long a step waits for its target to appear before it is passed over. */
const TARGET_WAIT_MS = 2_000;
/** Breathing room between the target's edge and the highlight. */
const HIGHLIGHT_PAD = 6;

interface Layout {
  stepId: string;
  box: Box | null;
  card: { width: number; height: number };
  viewport: { width: number; height: number };
}

/**
 * The tour on screen: the app dimmed, one control lifted out of the dim, and a
 * caption card beside it.
 *
 * **Measured by polling, not by observers.** A target can appear late (the
 * inspector mounts after the tour selects a quake), change size (the columns
 * grow and shrink at runtime) or move without resizing (the selection column
 * slides when a banner appears). A `ResizeObserver` sees only the second.
 * Five `getBoundingClientRect` calls a second, only while a tour shows, cover
 * all three.
 *
 * **It takes every pointer event**, for `LayerGuideModal`'s reason: Cesium's
 * hover picking and drag-deselect share one `MOUSE_MOVE` handler, so events
 * leaking through would pick and deselect underneath. It also means the tour
 * points and never lets a click land on what it points at.
 */
export function TourOverlay() {
  const steps = useTourStore((state) => state.steps);
  const index = useTourStore((state) => state.index);
  const direction = useTourStore((state) => state.direction);
  const next = useTourStore((state) => state.next);
  const back = useTourStore((state) => state.back);
  const end = useTourStore((state) => state.end);
  const noteSelection = useTourStore((state) => state.noteSelection);
  const select = useEarthquakeStore((state) => state.select);
  const events = useEarthquakesUpToPlayhead();
  const [layout, setLayout] = useState<Layout | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  const step = steps[index] ?? null;
  const stepId = step?.id ?? null;
  const target = step?.target ?? null;

  // Read by the step's action without making the catalogue a dependency: a
  // reload mid-tour must not re-select.
  const eventsRef = useRef(events);
  useEffect(() => {
    eventsRef.current = events;
  }, [events]);

  // The one thing the tour does: open the inspector on the largest quake
  // drawn, so that step shows the real panel. If nothing is drawn, the
  // inspector never appears and the step is passed over below.
  useEffect(() => {
    if (step?.action !== 'select-largest-quake') return;
    let largest = eventsRef.current[0];
    for (const event of eventsRef.current) if (largest === undefined || event.magnitude > largest.magnitude) largest = event;
    if (largest === undefined) return;
    if (useEarthquakeStore.getState().selectedEventId !== largest.id) {
      select(largest.id);
      noteSelection(largest.id);
    }
  }, [step, select, noteSelection]);

  useEffect(() => {
    if (stepId === null) return;
    const startedMs = performance.now();
    const measure = () => {
      const element = target === null ? null : document.getElementById(target);
      if (target !== null && element === null) {
        if (performance.now() - startedMs > TARGET_WAIT_MS) {
          if (direction === 1) next();
          else back();
        }
        return;
      }
      const rect = element?.getBoundingClientRect() ?? null;
      const card = cardRef.current;
      const measured: Layout = {
        stepId,
        box: rect === null ? null : { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        card: { width: card?.offsetWidth ?? 320, height: card?.offsetHeight ?? 180 },
        viewport: { width: window.innerWidth, height: window.innerHeight },
      };
      setLayout((previous) => (previous !== null && JSON.stringify(previous) === JSON.stringify(measured) ? previous : measured));
    };
    const first = setTimeout(measure, 0);
    const timer = setInterval(measure, MEASURE_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [stepId, target, direction, next, back]);

  useEffect(() => {
    if (stepId === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') end();
      else if (event.key === 'ArrowRight') next();
      else if (event.key === 'ArrowLeft') back();
    };
    window.addEventListener('keydown', onKey);
    cardRef.current?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [stepId, next, back, end]);

  if (step === null) return null;

  // Hidden until measured for *this* step, so the card never flashes at the
  // previous step's position or the default size.
  const current = layout?.stepId === step.id ? layout : null;
  const box = current?.box ?? null;
  const placement = current ? placeCard(box, current.card, current.viewport) : null;
  const last = index === steps.length - 1;

  return createPortal(
    <div className={styles.root} role="presentation">
      <div className={box === null ? styles.blockerDim : styles.blocker} />
      {box !== null && (
        <div
          className={styles.highlight}
          style={{
            left: box.left - HIGHLIGHT_PAD,
            top: box.top - HIGHLIGHT_PAD,
            width: box.width + HIGHLIGHT_PAD * 2,
            height: box.height + HIGHLIGHT_PAD * 2,
          }}
        />
      )}
      <div
        id="tour-card"
        ref={cardRef}
        className={styles.card}
        role="dialog"
        aria-label={step.title}
        tabIndex={-1}
        style={placement ? { left: placement.left, top: placement.top } : { visibility: 'hidden' }}
      >
        <div className={styles.count}>
          {index + 1} of {steps.length}
        </div>
        <h2 className={styles.title}>{step.title}</h2>
        <p className={styles.body}>{step.body}</p>
        <div className={styles.actions}>
          {!last && (
            <button id="tour-skip" type="button" className={styles.skip} onClick={end}>
              Skip tour
            </button>
          )}
          <span className={styles.spacer} />
          {index > 0 && (
            <button id="tour-back" type="button" className={styles.secondary} onClick={back}>
              Back
            </button>
          )}
          <button id="tour-next" type="button" className={styles.primary} onClick={next}>
            {last ? 'Done' : 'Next'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
