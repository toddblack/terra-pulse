import { describe, expect, it } from 'vitest';
import { compareVersions, parseVersion, updateNoticeShowing, type UpdateStatus } from './app-update';

describe('parseVersion', () => {
  it('reads plain and v-prefixed versions', () => {
    expect(parseVersion('0.1.0')).toEqual([0, 1, 0]);
    expect(parseVersion('v12.3.45')).toEqual([12, 3, 45]);
    expect(parseVersion(' v1.2.3 ')).toEqual([1, 2, 3]);
  });

  it('refuses anything that would make "newer" ambiguous', () => {
    for (const text of ['1.2', '1.2.3.4', '1.2.3-beta', 'v1.2.x', '01.2.3', '', 'latest', '1.2.3\n4']) {
      expect(parseVersion(text), text).toBeNull();
    }
  });
});

describe('compareVersions', () => {
  it('orders by major, then minor, then patch — numerically, not as text', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBeGreaterThan(0);
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.2.3', '1.2.4')).toBeLessThan(0);
  });

  it('is null when either side does not parse', () => {
    expect(compareVersions('1.2.3', 'nope')).toBeNull();
  });
});

describe('updateNoticeShowing', () => {
  const base: UpdateStatus = {
    currentVersion: '0.1.0',
    channel: 'github',
    enabled: true,
    state: 'available',
    latest: { version: '0.2.0', url: 'https://github.com/toddblack/terra-pulse/releases/tag/v0.2.0', publishedUtc: null },
    checkedAtUtc: null,
    dismissedVersion: null,
    detail: null,
  };

  it('shows for an available release nobody dismissed', () => {
    expect(updateNoticeShowing(base)).toBe(true);
  });

  it('stays quiet for a dismissed version, and speaks again for a newer one', () => {
    expect(updateNoticeShowing({ ...base, dismissedVersion: '0.2.0' })).toBe(false);
    expect(
      updateNoticeShowing({
        ...base,
        dismissedVersion: '0.2.0',
        latest: { ...base.latest!, version: '0.3.0' },
      }),
    ).toBe(true);
  });

  it('never shows outside the available state', () => {
    expect(updateNoticeShowing({ ...base, state: 'up-to-date' })).toBe(false);
    expect(updateNoticeShowing({ ...base, state: 'off' })).toBe(false);
    expect(updateNoticeShowing({ ...base, channel: 'store', state: 'store' })).toBe(false);
  });
});
