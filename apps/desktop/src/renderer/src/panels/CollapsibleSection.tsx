import type { ReactNode } from 'react';
import { useGlobeStore } from '../state/useGlobeStore';
import styles from './CollapsibleSection.module.css';

/**
 * One expandable section of the inspector.
 *
 * ## Why the body is unmounted rather than hidden
 *
 * `{open && children}` and not `display: none`. Each of these sections owns a
 * data hook — an IPC round trip into main — and unmounting is the only thing
 * that actually stops it running. Hiding with CSS would keep every query firing
 * on every selection and turn this into pure decoration.
 *
 * What that buys, measured elsewhere in this project: the recurrence query is
 * 32–294 ms of O(n²) declustering, the aftershock sequence 0.7–88 ms, and both
 * ran on every click through the event list before this existed. Collapsed,
 * they cost nothing.
 *
 * The cost of the choice is that collapsing and re-expanding the *same* event
 * refetches. That is a deliberate trade — it happens on a click, whereas the
 * thing it replaces happened on every selection whether or not anyone looked.
 *
 * ## Why the header can't carry a summary
 *
 * Follows directly from the above: "What followed — 47 aftershocks" would need
 * the query to have run, which is the cost being avoided. The heading states
 * the question instead, and the answer appears when asked for.
 */
export function CollapsibleSection({
  id,
  title,
  children,
}: {
  /** Stable across selections — it keys the expanded state in the store. */
  id: string;
  title: string;
  children: ReactNode;
}) {
  const open = useGlobeStore((state) => state.expandedSections[id] ?? false);
  const toggleSection = useGlobeStore((state) => state.toggleSection);
  const bodyId = `inspector-section-${id}`;

  return (
    <section className={styles.section}>
      {/* The button is inside the heading rather than replacing it: the section
          is still a heading in the document outline, and screen readers still
          announce the level. `aria-expanded` is what carries the state. */}
      <h3 className={styles.heading}>
        <button
          type="button"
          id={`inspector-toggle-${id}`}
          className={styles.toggle}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => {
            toggleSection(id);
          }}
        >
          <span className={styles.chevron} aria-hidden="true">
            ▶
          </span>
          <span className={styles.title}>{title}</span>
          {/* Redundant with `aria-expanded` for assistive tech, so hidden from
              it — this is for the eye, which a 0.7rem rotated triangle does not
              serve well on its own. */}
          <span className={styles.state} aria-hidden="true">
            {open ? 'hide' : 'show'}
          </span>
        </button>
      </h3>

      {open && (
        <div id={bodyId} className={styles.body}>
          {children}
        </div>
      )}
    </section>
  );
}
