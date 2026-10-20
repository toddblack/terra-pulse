import { describe, expect, it } from 'vitest';
import { GLOBE_FAILURE_DETAIL_MAX } from '@terra-pulse/schema';
import { describeGlobeFailure, isGraphicsFailure } from './globe-failure';

/** Cesium's errors are plain objects with a name and message, not `Error` subclasses. */
const runtime = (message: string) => ({ name: 'RuntimeError', message });

describe('isGraphicsFailure', () => {
  it('recognises the failure the Store review hit', () => {
    // Verbatim from the certification screenshot, empty log included.
    expect(isGraphicsFailure(runtime('Fragment shader failed to compile.  Compile log: '))).toBe(
      true,
    );
  });

  it('recognises the other shader and WebGL failures Cesium raises', () => {
    expect(
      isGraphicsFailure(runtime('Vertex shader failed to compile.  Compile log: ERROR: 0:1')),
    ).toBe(true);
    expect(isGraphicsFailure(runtime('Program failed to link.  Link log: '))).toBe(true);
    expect(
      isGraphicsFailure(runtime('The browser supports WebGL, but initialization failed.')),
    ).toBe(true);
    expect(isGraphicsFailure(runtime('WebGL Error:  OUT_OF_MEMORY: texImage2D();'))).toBe(true);
  });

  it('leaves our own bugs alone', () => {
    // These must keep reaching Cesium's error panel. Treated as driver
    // failures, a broken layer would push every reader into software rendering.
    expect(
      isGraphicsFailure({ name: 'DeveloperError', message: 'Expected width to be greater than 0' }),
    ).toBe(false);
    expect(
      isGraphicsFailure(new TypeError("Cannot read properties of undefined (reading 'x')")),
    ).toBe(false);
    expect(isGraphicsFailure(runtime('Out of unique Pick IDs.'))).toBe(false);
    expect(isGraphicsFailure({ name: 'Error', message: 'shader failed to compile' })).toBe(false);
    expect(isGraphicsFailure(null)).toBe(false);
    expect(isGraphicsFailure('shader failed to compile')).toBe(false);
  });
});

describe('describeGlobeFailure', () => {
  it('names the error and the GPU', () => {
    expect(
      describeGlobeFailure(
        runtime('Fragment shader failed to compile.  Compile log: '),
        'ANGLE (X)',
      ),
    ).toBe('RuntimeError: Fragment shader failed to compile.  Compile log: (GPU: ANGLE (X))');
  });

  it('copes with errors that say nothing', () => {
    expect(describeGlobeFailure(undefined, null)).toBe('unknown error');
    expect(describeGlobeFailure('lost', null)).toBe('lost');
  });

  it('stays short whatever the driver sends', () => {
    const long = runtime(`Fragment shader failed to compile.  Compile log: ${'x'.repeat(10_000)}`);
    expect(describeGlobeFailure(long, 'GPU').length).toBe(GLOBE_FAILURE_DETAIL_MAX);
  });
});
