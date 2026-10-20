import { GLOBE_FAILURE_DETAIL_MAX } from '@terra-pulse/schema';

/**
 * Which render errors mean "this graphics stack cannot draw the globe", as
 * opposed to a bug in our own code.
 *
 * The difference decides what happens next. A driver failure moves the app
 * one step off the graphics card (`graphics-mode.ts` in the schema); a bug
 * must not, or a broken layer would quietly put every reader into slow
 * software rendering while the bug stayed hidden. So this is narrow: Cesium's
 * own `RuntimeError` for a shader that would not compile, a program that
 * would not link, or WebGL itself. Everything else still gets Cesium's error
 * panel, as it always did.
 *
 * Read by shape rather than `instanceof`: Cesium's errors are not `Error`
 * subclasses, and a check against one bundled copy of the class is the kind
 * of thing that silently stops matching.
 */
const GRAPHICS_MESSAGE = /shader failed to compile|failed to link|webgl/i;

function nameAndMessage(error: unknown): { name: string; message: string } {
  if (typeof error === 'object' && error !== null) {
    const record = error as { name?: unknown; message?: unknown };
    return {
      name: typeof record.name === 'string' ? record.name : '',
      message: typeof record.message === 'string' ? record.message : '',
    };
  }
  return { name: '', message: typeof error === 'string' ? error : '' };
}

export function isGraphicsFailure(error: unknown): boolean {
  const { name, message } = nameAndMessage(error);
  return name === 'RuntimeError' && GRAPHICS_MESSAGE.test(message);
}

/**
 * One line for main to keep and log: the error, and which GPU produced it.
 *
 * The GPU's name is what makes a report like the Store's actionable — it is
 * the one fact the certification report did not include. A shader's source is
 * deliberately not kept; it runs to kilobytes and says nothing the error
 * message and the renderer name do not.
 */
export function describeGlobeFailure(error: unknown, gpu: string | null): string {
  const { name, message } = nameAndMessage(error);
  const what =
    [name, message.trim()].filter((part) => part.length > 0).join(': ') || 'unknown error';
  const text = gpu ? `${what} (GPU: ${gpu})` : what;
  return text.slice(0, GLOBE_FAILURE_DETAIL_MAX);
}
