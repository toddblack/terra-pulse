import { useEffect, useRef } from 'react';
import { useGlobeStore } from '../state/useGlobeStore';
import { guideFor } from './layer-guides';
import { trackGuideFor } from './track-guides';
import styles from './LayerGuideModal.module.css';

/**
 * The explanation for one layer — or, since §5.5, one multi-track timeline
 * row — over the centre of the app.
 *
 * Despite the name, this now serves two id namespaces: `guideFor` looks up
 * the globe layer registry (`layer-guides.ts`), `trackGuideFor` looks up the
 * timeline rows (`track-guides.ts`). They stay two separate files with two
 * separate completeness checks — see `track-guides.ts`'s own doc for why —
 * but the actual dialog, its keyboard/backdrop handling and its styling are
 * identical for both, so this component (and `LayerGuideButton` below) is
 * the one place that knows both exist.
 *
 * ## Why it must swallow pointer events
 *
 * Cesium's hover picking and drag-deselect both run off `MOUSE_MOVE`, and
 * `setInputAction` holds exactly one handler per event type. If this overlay let
 * pointer events through, you would get tooltips appearing and selections being
 * cleared *underneath an open dialog* — so the backdrop covers the viewport and
 * takes the events itself rather than being a decorative tint.
 *
 * ## Why the caveats come last but read first
 *
 * The sections are ordered what-it-is, how-to-read-it, what-it-cannot-tell-you,
 * where-it-came-from. "Cannot tell you" is the section that earns the feature,
 * so it is styled as the emphatic one rather than buried as fine print — a
 * reader who only ever reads that part is still better off.
 */
export function LayerGuideModal() {
  const openGuideLayerId = useGlobeStore((state) => state.openGuideLayerId);
  const closeGuide = useGlobeStore((state) => state.closeGuide);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // Escape closes, and focus moves into the dialog so a keyboard reader is not
  // left behind on the button that opened it.
  useEffect(() => {
    if (openGuideLayerId === null) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeGuide();
    };
    window.addEventListener('keydown', onKeyDown);
    dialogRef.current?.focus();

    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [openGuideLayerId, closeGuide]);

  if (openGuideLayerId === null) return null;

  const guide = guideFor(openGuideLayerId) ?? trackGuideFor(openGuideLayerId);
  if (!guide) return null;

  return (
    <div
      className={styles.backdrop}
      // Click-outside closes. On the backdrop only, so a click inside the panel
      // does not fall through to it.
      onClick={closeGuide}
      role="presentation"
    >
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={`About ${guide.title}`}
        tabIndex={-1}
        ref={dialogRef}
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <header className={styles.header}>
          <h2 className={styles.title}>{guide.title}</h2>
          <button
            type="button"
            className={styles.closeButton}
            onClick={closeGuide}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <p className={styles.shows}>{guide.shows}</p>

        <h3 className={styles.sectionHeading}>How to read it</h3>
        <ul className={styles.list}>
          {guide.reading.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>

        {/* The section that earns the feature. */}
        <h3 className={`${styles.sectionHeading} ${styles.limitsHeading}`}>
          What it can’t tell you
        </h3>
        <ul className={`${styles.list} ${styles.limits}`}>
          {guide.limits.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>

        <p className={styles.source}>{guide.source}</p>
      </div>
    </div>
  );
}

/**
 * The `?` that opens a guide — for a registered layer or a track row alike.
 *
 * Rendered only when a guide exists, so an unexplained layer or row shows no
 * affordance rather than an affordance that opens nothing.
 */
export function LayerGuideButton({ layerId }: { layerId: string }) {
  const openGuide = useGlobeStore((state) => state.openGuide);
  if (!guideFor(layerId) && !trackGuideFor(layerId)) return null;

  return (
    <button
      type="button"
      className={styles.infoButton}
      // Stopped so a `?` inside a clickable row does not also toggle the layer.
      onClick={(event) => {
        event.stopPropagation();
        openGuide(layerId);
      }}
      aria-label="About this"
      title="What is this?"
    >
      ?
    </button>
  );
}
