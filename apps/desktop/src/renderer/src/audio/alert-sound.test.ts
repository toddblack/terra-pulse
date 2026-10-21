import { describe, expect, it } from 'vitest';
import { ALERT_SOUND_URL } from './alert-sound';

describe('ALERT_SOUND_URL', () => {
  // A built app is a file:// page. Measured in one: `/sounds/eq-alert.mp3`
  // resolved to file:///C:/sounds/eq-alert.mp3 and failed (MEDIA_ERR 4), while
  // the relative form played. The failure is silent by design, so only this
  // test notices.
  it('resolves next to the page, not at the drive root, when loaded from file://', () => {
    const page = 'file:///C:/Program%20Files/Terra%20Pulse/resources/app.asar/out/renderer/index.html';
    expect(new URL(ALERT_SOUND_URL, page).href).toBe(
      'file:///C:/Program%20Files/Terra%20Pulse/resources/app.asar/out/renderer/sounds/eq-alert.mp3',
    );
  });

  it('still resolves at the dev server root', () => {
    expect(new URL(ALERT_SOUND_URL, 'http://localhost:5173/').href).toBe('http://localhost:5173/sounds/eq-alert.mp3');
  });
});
