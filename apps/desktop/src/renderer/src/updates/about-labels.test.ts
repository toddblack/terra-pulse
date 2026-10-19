import { describe, expect, it } from 'vitest';
import type { UpdateStatus } from '@terra-pulse/schema';
import { updateSummary, versionLabel } from './about-labels';

const NOW = Date.parse('2026-11-02T00:10:00Z');

const base: UpdateStatus = {
  currentVersion: '0.1.0',
  enabled: true,
  state: 'up-to-date',
  latest: null,
  checkedAtUtc: '2026-11-02T00:00:00Z',
  dismissedVersion: null,
  detail: null,
};

describe('updateSummary', () => {
  it('says when "up to date" was last true', () => {
    expect(updateSummary(base, NOW)).toBe('Up to date · checked 10m ago');
  });

  it('names the newer version', () => {
    const status: UpdateStatus = {
      ...base,
      state: 'available',
      latest: { version: '0.2.0', url: 'https://github.com/toddblack/terra-pulse/releases/tag/v0.2.0', publishedUtc: null },
    };
    expect(updateSummary(status, NOW)).toBe('Terra Pulse 0.2.0 is available · checked 10m ago');
  });

  it('carries main’s detail for "no release yet" and for failures', () => {
    expect(updateSummary({ ...base, detail: 'No release has been published yet.' }, NOW)).toBe(
      'No release has been published yet · checked 10m ago',
    );
    expect(updateSummary({ ...base, state: 'failed', detail: 'Could not reach GitHub.' }, NOW)).toBe(
      'Could not check: Could not reach GitHub · checked 10m ago',
    );
  });

  it('claims nothing when off or not yet checked', () => {
    expect(updateSummary({ ...base, state: 'off', enabled: false, checkedAtUtc: null }, NOW)).toBe('Update check is off.');
    expect(updateSummary({ ...base, state: 'not-checked', checkedAtUtc: null }, NOW)).toBe('Not checked yet.');
  });
});

describe('versionLabel', () => {
  it('is the version, or a prompt while a notice is showing', () => {
    expect(versionLabel(base, false)).toBe('v0.1.0');
    expect(versionLabel(base, true)).toBe('Update');
  });
});
