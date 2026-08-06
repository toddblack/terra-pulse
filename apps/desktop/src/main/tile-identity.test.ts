import { describe, expect, it, vi } from 'vitest';
import type { Session } from 'electron';
import { TILE_HOSTS, applyTileIdentity, isTileRequest, tileUserAgent } from './tile-identity';

describe('tileUserAgent', () => {
  it('names the app and carries a version', () => {
    expect(tileUserAgent('1.2.3')).toBe(
      'TerraPulse/1.2.3 (+https://github.com/toddblack/terra-pulse)',
    );
  });

  /**
   * OSM's policy rejects "a library's generic default User-Agent" and treats
   * masquerading as another app as grounds for blocking. A string containing
   * "Mozilla" or "Chrome" invites exactly that reading, and appending to
   * Chromium's UA is the obvious wrong turn here.
   */
  it('does not masquerade as a browser', () => {
    const agent = tileUserAgent('0.0.0');
    expect(agent).not.toMatch(/Mozilla|Chrome|AppleWebKit|Electron/i);
  });

  it('includes a contact URL an operator could actually use', () => {
    // An identifier nobody can reach is barely better than none.
    expect(tileUserAgent('0.0.0')).toMatch(/https?:\/\//);
  });
});

describe('isTileRequest', () => {
  it.each(TILE_HOSTS)('matches %s', (host) => {
    expect(isTileRequest(`https://${host}/10/511/340.png`)).toBe(true);
  });

  it('matches a subdomain of a tile host', () => {
    expect(isTileRequest('https://a.tile.openstreetmap.org/10/511/340.png')).toBe(true);
  });

  it('leaves unrelated hosts alone', () => {
    // The identity is scoped rather than global, so requests to anything else
    // must keep the default UA — including our own data sources.
    expect(isTileRequest('https://earthquake.usgs.gov/fdsnws/event/1/query')).toBe(false);
    expect(isTileRequest('https://example.com/tile.openstreetmap.org')).toBe(false);
  });

  /**
   * A host merely *ending* in the tile host's name is a different domain —
   * `nottile.openstreetmap.org.evil.com` must not be treated as OSM. The check
   * requires a dot boundary for exactly this.
   */
  it('does not match a lookalike domain', () => {
    expect(isTileRequest('https://tile.openstreetmap.org.evil.com/1/2/3.png')).toBe(false);
    expect(isTileRequest('https://faketile.openstreetmap.org/1/2/3.png')).toBe(false);
  });

  it('treats an unparseable URL as not a tile request', () => {
    expect(isTileRequest('not a url')).toBe(false);
    expect(isTileRequest('')).toBe(false);
  });
});

/** Captures the handler the real session would have registered. */
function fakeSession() {
  let handler: ((details: { url: string; requestHeaders: Record<string, string> }, cb: (r: { requestHeaders: Record<string, string> }) => void) => void) | null = null;
  const session = {
    webRequest: {
      onBeforeSendHeaders: vi.fn((fn: typeof handler) => {
        handler = fn;
      }),
    },
  } as unknown as Session;

  return {
    session,
    send(url: string, headers: Record<string, string> = { 'User-Agent': 'Mozilla/5.0 stock' }) {
      let result: Record<string, string> = {};
      handler?.({ url, requestHeaders: headers }, (r) => {
        result = r.requestHeaders;
      });
      return result;
    },
  };
}

describe('applyTileIdentity', () => {
  it('stamps the identity on a tile request', () => {
    const fake = fakeSession();
    applyTileIdentity(fake.session, '0.0.0');

    const headers = fake.send('https://tile.openstreetmap.org/12/2048/1361.png');
    expect(headers['User-Agent']).toBe(tileUserAgent('0.0.0'));
  });

  it('leaves other requests untouched', () => {
    const fake = fakeSession();
    applyTileIdentity(fake.session, '0.0.0');

    const headers = fake.send('https://earthquake.usgs.gov/fdsnws/event/1/query');
    expect(headers['User-Agent']).toBe('Mozilla/5.0 stock');
  });

  it('preserves the other headers on a tile request', () => {
    // Replacing the header bag instead of merging it would drop Accept,
    // Accept-Encoding and the rest — which breaks the request in ways that look
    // nothing like a User-Agent problem.
    const fake = fakeSession();
    applyTileIdentity(fake.session, '0.0.0');

    const headers = fake.send('https://tile.openstreetmap.org/1/1/1.png', {
      'User-Agent': 'stock',
      Accept: 'image/avif,image/webp,*/*',
      'Accept-Encoding': 'gzip, deflate, br',
    });
    expect(headers['Accept']).toBe('image/avif,image/webp,*/*');
    expect(headers['Accept-Encoding']).toBe('gzip, deflate, br');
  });

  it('registers exactly one handler', () => {
    const fake = fakeSession();
    applyTileIdentity(fake.session, '0.0.0');
    expect(fake.session.webRequest.onBeforeSendHeaders).toHaveBeenCalledTimes(1);
  });
});
