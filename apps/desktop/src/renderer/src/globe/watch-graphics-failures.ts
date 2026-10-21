import * as Cesium from 'cesium';
import { NO_FRAME_TIMEOUT_S, nextFramelessSeconds } from '@terra-pulse/schema';
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
 * Reports a graphics failure when the page stops getting animation frames.
 *
 * **This is the case nothing else can see.** The Store's second rejection was
 * a white window: no error, no panel, nothing for `watchGraphicsFailures` to
 * catch, because the page itself was running. Chromium produces frames in the
 * GPU process and hands each one to the window there; when that path is stuck,
 * the page's `requestAnimationFrame` stops being called while its timers carry
 * on. So a visible page whose timers run and whose frames do not is a window
 * that is not drawing, and the next graphics mode is the way out.
 *
 * Only visible seconds count (a hidden or minimised window gets no frames by
 * design), and a busy main thread stops the timer too, so neither can trip it.
 * See `NO_FRAME_TIMEOUT_S` for the threshold.
 *
 * The report carries no GPU name, unlike the others: asking for one creates a
 * WebGL context, a synchronous round trip to the very GPU process suspected of
 * being stuck.
 */
export function watchFrameDelivery(report: (detail: string) => void): () => void {
  let frames = 0;
  let frameless = 0;
  let rafId = 0;
  const onFrame = () => {
    frames++;
    rafId = requestAnimationFrame(onFrame);
  };
  rafId = requestAnimationFrame(onFrame);

  const timer = setInterval(() => {
    frameless = nextFramelessSeconds(frameless, {
      visible: document.visibilityState === 'visible',
      frames,
    });
    frames = 0;
    if (frameless >= NO_FRAME_TIMEOUT_S) {
      clearInterval(timer);
      cancelAnimationFrame(rafId);
      report(`No frame reached the window in ${String(NO_FRAME_TIMEOUT_S)} s while it was visible`);
    }
  }, 1000);

  return () => {
    clearInterval(timer);
    cancelAnimationFrame(rafId);
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
