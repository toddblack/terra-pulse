import { describe, expect, it } from 'vitest';
import {
  GRAPHICS_MODES,
  HARDWARE_GRAPHICS,
  NO_FRAME_TIMEOUT_S,
  graphicsStatusFrom,
  isRemoteSessionName,
  modeAfterFailure,
  nextFramelessSeconds,
  onlySoftwareAdapter,
  serialiseGraphicsState,
  softwareRenderingNote,
} from './graphics-mode';

describe('graphicsStatusFrom', () => {
  it('reads back what was saved for this version', () => {
    const text = serialiseGraphicsState({
      mode: 'software',
      reason: 'shader failed',
      appVersion: '0.1.4',
    });
    expect(graphicsStatusFrom(text, '0.1.4')).toEqual({ mode: 'software', reason: 'shader failed' });
  });

  it('tries the graphics card again after an update', () => {
    const text = serialiseGraphicsState({ mode: 'swiftshader', reason: null, appVersion: '0.1.4' });
    expect(graphicsStatusFrom(text, '0.1.5')).toEqual(HARDWARE_GRAPHICS);
  });

  it('ignores the retired WARP step, even for the same version', () => {
    // 0.1.2/0.1.3 wrote `warp`; that step showed the window through the GPU.
    expect(graphicsStatusFrom('{"mode":"warp","appVersion":"0.1.3"}', '0.1.3')).toEqual(
      HARDWARE_GRAPHICS,
    );
  });

  it('falls back to hardware on anything it cannot trust', () => {
    // A damaged file must never strand someone in software rendering.
    for (const text of [
      null,
      '',
      'not json',
      'null',
      '[]',
      '{"mode":"gpu","appVersion":"0.1.4"}',
      '{"mode":"software"}',
    ]) {
      expect(graphicsStatusFrom(text, '0.1.4')).toEqual(HARDWARE_GRAPHICS);
    }
  });

  it('drops a reason that is not text', () => {
    expect(
      graphicsStatusFrom('{"mode":"software","appVersion":"1.0.0","reason":42}', '1.0.0'),
    ).toEqual({ mode: 'software', reason: null });
  });
});

describe('modeAfterFailure', () => {
  it('steps hardware → software → SwiftShader on Windows, then stops', () => {
    expect(modeAfterFailure('hardware', 'win32')).toBe('software');
    expect(modeAfterFailure('software', 'win32')).toBe('swiftshader');
    // The end of the ladder. Anything else would restart forever.
    expect(modeAfterFailure('swiftshader', 'win32')).toBeNull();
  });

  it('skips the WARP-backed step where Windows is not underneath', () => {
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
  it('says nothing on the graphics card and names software otherwise', () => {
    expect(softwareRenderingNote(HARDWARE_GRAPHICS)).toBeNull();
    expect(softwareRenderingNote({ mode: 'software', reason: null })).toContain('software');
    expect(softwareRenderingNote({ mode: 'swiftshader', reason: null })).toContain('SwiftShader');
  });
});

describe('isRemoteSessionName', () => {
  it('recognises a Remote Desktop session and nothing else', () => {
    expect(isRemoteSessionName('RDP-Tcp#3')).toBe(true);
    expect(isRemoteSessionName('rdp-tcp#0')).toBe(true);
    expect(isRemoteSessionName('Console')).toBe(false);
    expect(isRemoteSessionName('')).toBe(false);
    expect(isRemoteSessionName(undefined)).toBe(false);
  });

  it('gets its own note, which does not promise the next update will help', () => {
    const note = softwareRenderingNote({ mode: 'software', reason: null, remoteSession: true });
    expect(note).toContain('Remote Desktop');
    expect(note).not.toContain('update');
  });
});

describe('onlySoftwareAdapter', () => {
  const intel = { vendorId: 0x8086, deviceId: 0xa788 };
  const nvidia = { vendorId: 0x10de, deviceId: 0x2860 };
  const basicRender = { vendorId: 0x1414, deviceId: 0x8c };

  it('is true for a machine whose only adapter is Windows’ own', () => {
    expect(onlySoftwareAdapter([{ ...basicRender, active: true }])).toBe(true);
    expect(onlySoftwareAdapter([basicRender])).toBe(true);
  });

  it('is false for a real graphics card, including a laptop with two', () => {
    expect(onlySoftwareAdapter([{ ...intel, active: true }, nvidia])).toBe(false);
    expect(onlySoftwareAdapter([intel, { ...nvidia, active: true }])).toBe(false);
  });

  it('follows the active adapter, not merely the presence of a Microsoft one', () => {
    expect(onlySoftwareAdapter([{ ...intel, active: true }, basicRender])).toBe(false);
    expect(onlySoftwareAdapter([intel, { ...basicRender, active: true }])).toBe(true);
  });

  it('treats an empty or missing list as no evidence', () => {
    expect(onlySoftwareAdapter([])).toBe(false);
    expect(onlySoftwareAdapter(undefined)).toBe(false);
    expect(onlySoftwareAdapter([{}])).toBe(false);
  });
});

describe('nextFramelessSeconds', () => {
  it('counts visible seconds with no frame and resets on a frame', () => {
    let n = 0;
    for (let i = 0; i < 5; i++) n = nextFramelessSeconds(n, { visible: true, frames: 0 });
    expect(n).toBe(5);
    expect(nextFramelessSeconds(n, { visible: true, frames: 1 })).toBe(0);
  });

  it('does not count hidden seconds, and does not forget across them', () => {
    // A window minimised for a minute is not "ten seconds without a frame".
    let n = nextFramelessSeconds(3, { visible: false, frames: 0 });
    expect(n).toBe(3);
    for (let i = 0; i < 60; i++) n = nextFramelessSeconds(n, { visible: false, frames: 0 });
    expect(n).toBe(3);
  });

  it('a hidden second with a frame still resets', () => {
    expect(nextFramelessSeconds(9, { visible: false, frames: 2 })).toBe(0);
  });

  it('gives a slow software mode room to draw', () => {
    // SwiftShader draws ~4 fps; a timeout under a second would trip on it.
    expect(NO_FRAME_TIMEOUT_S).toBeGreaterThanOrEqual(5);
  });
});
