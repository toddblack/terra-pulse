import * as Cesium from 'cesium';
import { describeGlobeFailure, isGraphicsFailure } from './globe-failure';

/**
 * The GPU's name, from a throwaway context: the one fact that makes a failure
 * report actionable. Null when even that cannot be had.
 */
export function gpuName(): string | null {
  try {
    const gl =
      document.createElement('canvas').getContext('webgl2') ??
      document.createElement('canvas').getContext('webgl');
    if (!gl) return null;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const name: unknown = gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
    // Hand the context back now rather than waiting for GC: Chromium caps how
    // many live contexts a page may hold, and the globe's is one of them.
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
}

/**
 * Routes the globe's render failures: graphics failures to `report`, anything
 * else to Cesium's own panel, exactly as before.
 *
 * **It intercepts `showErrorPanel` rather than listening to `renderError`.**
 * Cesium stops rendering by two paths: `scene.renderError`, for errors inside
 * `scene.render`, and a `catch` in the widget's render loop for anything
 * around it (resize, frame setup), which raises no event at all. Both end in
 * `showErrorPanel`. Turning `showRenderLoopErrors` off and listening to the
 * event — the first version of this — left the second path stopping the globe
 * silently, worse than Cesium's modal. One interception covers both.
 *
 * **A lost context counts as a graphics failure.** Cesium cannot recover from
 * one — rendering stops and the globe stays blank, which is what the Store
 * reviewer's second screenshot shows. Restarting in the *same* mode could
 * lose it the same way and loop; moving one step off the graphics card cannot
 * loop, because the steps run out. The cost: a one-off GPU reset leaves the
 * app in software rendering until the next update, or until the reader uses
 * the About panel's way back.
 */
export function watchGraphicsFailures(
  viewer: Cesium.Viewer,
  report: (detail: string) => void,
): () => void {
  // After a failure, more errors follow from the same cause (a lost context is
  // followed by every frame failing). One report, and no panel over the notice.
  let reported = false;

  const fail = (error: unknown) => {
    if (reported) return;
    reported = true;
    report(describeGlobeFailure(error, gpuName()));
  };

  const widget = viewer.cesiumWidget;
  const showErrorPanel = widget.showErrorPanel.bind(widget);
  // Typed as taking a string, but both render-loop callers pass the raw error
  // object, which is what classifying needs.
  widget.showErrorPanel = (title: string, message?: string, error?: unknown) => {
    if (reported) return;
    if (isGraphicsFailure(error)) {
      fail(error);
      return;
    }
    // Our own bug, not the driver's: Cesium's panel, unchanged. Passed through
    // raw, as Cesium's own callers do — formatting it here first would print
    // "Error: TypeError: …", a panel subtly different from before.
    showErrorPanel(title, message, error as string | undefined);
  };

  const canvas = viewer.scene.canvas;
  const onContextLost = () => {
    fail({ name: 'RuntimeError', message: 'WebGL context lost' });
  };
  canvas.addEventListener('webglcontextlost', onContextLost);

  return () => {
    widget.showErrorPanel = showErrorPanel;
    canvas.removeEventListener('webglcontextlost', onContextLost);
  };
}

/**
 * Removes the panel Cesium shows when the viewer fails to build. The
 * constructor shows it and then throws, before there is a widget to
 * intercept, so for a graphics failure it is taken down afterwards.
 */
export function clearConstructionErrorPanel(container: HTMLElement): void {
  for (const panel of container.querySelectorAll('.cesium-widget-errorPanel')) panel.remove();
}
