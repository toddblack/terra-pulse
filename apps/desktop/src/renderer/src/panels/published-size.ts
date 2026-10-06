/**
 * A ref callback that publishes an element's measured size into a CSS custom
 * property on the document element, and keeps it current.
 *
 * ## Why measurements and not constants
 *
 * The panels around the globe change size at runtime — track rows toggle, the
 * archive panel opens, the legend gains sections, the dock minimises — and a
 * neighbour that clears them with a hand-picked `calc(100vh - 37rem)` is wrong
 * on the next toggle. That exact constant once shipped with a comment admitting
 * its last two increases had never been checked against the running app. It is
 * `App.module.css`'s panel-placement rule: "any `top` offset or `max-height` on
 * a neighbour is a guess that goes wrong on the next toggle or resize."
 *
 * Set on the document element rather than passed through React because the
 * readers are CSS modules belonging to unrelated components.
 *
 * **A ref callback, not an effect.** An effect keyed on a conditionally rendered
 * element leaves its observer watching a detached node; this app has shipped a
 * blank panel over that once. React 19 runs the returned cleanup on detach.
 *
 * **The property is removed on detach.** `ExploreShell` unmounts entirely when
 * Analyze is selected, and a stale size left behind would reserve space for a
 * panel that is not on screen. Readers carry a fallback for that state.
 *
 * Measured with `getBoundingClientRect()`, **not `entry.contentRect`**, which
 * excludes padding — they disagree by ~20px on a padded panel, and what a
 * neighbour has to clear is the box on screen.
 *
 * Create once at module scope: the callback's identity must be stable, or React
 * detaches and re-attaches it on every render.
 */
export function publishSize(
  property: string,
  dimension: 'width' | 'height',
): (node: HTMLElement | null) => (() => void) | undefined {
  return (node) => {
    if (!node) return undefined;

    const publish = () => {
      const size = node.getBoundingClientRect()[dimension];
      if (size > 0) document.documentElement.style.setProperty(property, `${String(size)}px`);
    };

    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(node);

    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty(property);
    };
  };
}
