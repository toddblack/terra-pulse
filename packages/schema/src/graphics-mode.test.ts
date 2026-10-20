import { describe, expect, it } from 'vitest';
import {
  GRAPHICS_MODES,
  HARDWARE_GRAPHICS,
  graphicsStatusFrom,
  modeAfterFailure,
  serialiseGraphicsState,
  softwareRenderingNote,
} from './graphics-mode';

describe('graphicsStatusFrom', () => {
  it('reads back what was saved for this version', () => {
    const text = serialiseGraphicsState({
      mode: 'warp',
      reason: 'shader failed',
      appVersion: '0.1.2',
    });
    expect(graphicsStatusFrom(text, '0.1.2')).toEqual({ mode: 'warp', reason: 'shader failed' });
  });

  it('tries the graphics card again after an update', () => {
    const text = serialiseGraphicsState({ mode: 'swiftshader', reason: null, appVersion: '0.1.2' });
    expect(graphicsStatusFrom(text, '0.1.3')).toEqual(HARDWARE_GRAPHICS);
  });

  it('falls back to hardware on anything it cannot trust', () => {
    // A damaged file must never strand someone in software rendering.
    for (const text of [
      null,
      '',
      'not json',
      'null',
      '[]',
      '{"mode":"gpu","appVersion":"0.1.2"}',
      '{"mode":"warp"}',
    ]) {
      expect(graphicsStatusFrom(text, '0.1.2')).toEqual(HARDWARE_GRAPHICS);
    }
  });

  it('drops a reason that is not text', () => {
    expect(graphicsStatusFrom('{"mode":"warp","appVersion":"1.0.0","reason":42}', '1.0.0')).toEqual(
      {
        mode: 'warp',
        reason: null,
      },
    );
  });
});

describe('modeAfterFailure', () => {
  it('steps hardware → WARP → SwiftShader on Windows, then stops', () => {
    expect(modeAfterFailure('hardware', 'win32')).toBe('warp');
    expect(modeAfterFailure('warp', 'win32')).toBe('swiftshader');
    // The end of the ladder. Anything else would restart forever.
    expect(modeAfterFailure('swiftshader', 'win32')).toBeNull();
  });

  it('skips WARP where Windows is not underneath', () => {
    expect(modeAfterFailure('hardware', 'darwin')).toBe('swiftshader');
    expect(modeAfterFailure('hardware', 'linux')).toBe('swiftshader');
  });

  it('only ever moves along the declared order', () => {
    for (const platform of ['win32', 'darwin']) {
      for (const mode of GRAPHICS_MODES) {
        const next = modeAfterFailure(mode, platform);
        if (next !== null)
          expect(GRAPHICS_MODES.indexOf(next)).toBeGreaterThan(GRAPHICS_MODES.indexOf(mode));
      }
    }
  });
});

describe('softwareRenderingNote', () => {
  it('says nothing on the graphics card and names the renderer otherwise', () => {
    expect(softwareRenderingNote(HARDWARE_GRAPHICS)).toBeNull();
    expect(softwareRenderingNote({ mode: 'warp', reason: null })).toContain('WARP');
    expect(softwareRenderingNote({ mode: 'swiftshader', reason: null })).toContain('SwiftShader');
  });
});
