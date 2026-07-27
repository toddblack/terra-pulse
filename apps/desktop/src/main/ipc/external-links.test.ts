import { describe, expect, it } from 'vitest';
import { isAllowedExternalUrl } from './external-links';

describe('isAllowedExternalUrl', () => {
  it('allows a real USGS event page', () => {
    expect(
      isAllowedExternalUrl('https://earthquake.usgs.gov/earthquakes/eventpage/us7000t37a'),
    ).toBe(true);
  });

  // Every URL below must be REJECTED. If any of these ever starts returning
  // true, something has gone wrong with the validator.
  it.each([
    ['http://earthquake.usgs.gov/x', 'plain http, even on the allowed host'],
    ['file:///C:/Windows/System32/calc.exe', 'file scheme'],
    ['javascript:alert(1)', 'javascript scheme'],
    ['ms-msdt:/id', 'os handler scheme'],
  ])('rejects %s — %s', (url) => {
    expect(isAllowedExternalUrl(url)).toBe(false);
  });

  it('rejects other hosts, including ones that merely contain the allowed name', () => {
    expect(isAllowedExternalUrl('https://example.com/')).toBe(false);
    // Would slip through a naive `includes()` check.
    expect(isAllowedExternalUrl('https://earthquake.usgs.gov.evil.test/x')).toBe(false);
    expect(isAllowedExternalUrl('https://evil.test/?q=earthquake.usgs.gov')).toBe(false);
  });

  it('rejects a userinfo trick that puts the allowed host before an @', () => {
    // The real host here is evil.test. Parsing is what catches this, which is
    // exactly why this goes through URL rather than string matching.
    expect(isAllowedExternalUrl('https://earthquake.usgs.gov@evil.test/')).toBe(false);
  });

  it('rejects unparseable input', () => {
    expect(isAllowedExternalUrl('not a url')).toBe(false);
    expect(isAllowedExternalUrl('')).toBe(false);
  });
});
