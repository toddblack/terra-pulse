import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LATEST_RELEASE_URL,
  createUpdateChecker,
  isReleasePage,
  parseLatestRelease,
  type UpdateCheckerOptions,
} from './update-check';

const PAGE = 'https://github.com/toddblack/terra-pulse/releases/tag/v0.2.0';

function release(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag_name: 'v0.2.0',
    html_url: PAGE,
    draft: false,
    prerelease: false,
    published_at: '2026-11-01T12:00:00Z',
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A checker over an in-memory app_state, so persistence is visible to the test. */
function setUp(fetchImpl: typeof fetch, stored: Record<string, string> = {}, currentVersion = '0.1.0') {
  const state = new Map(Object.entries(stored));
  const pushes: string[] = [];
  const options: UpdateCheckerOptions = {
    currentVersion,
    userAgent: 'TerraPulse/0.1.0 (+https://github.com/toddblack/terra-pulse)',
    readState: (key) => state.get(key) ?? null,
    writeState: (key, value) => {
      if (value === null) state.delete(key);
      else state.set(key, value);
    },
    fetchImpl,
    now: () => new Date('2026-11-02T00:00:00Z'),
    onStatus: (status) => pushes.push(status.state),
  };
  return { checker: createUpdateChecker(options), state, pushes };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('parseLatestRelease', () => {
  it('keeps the version without its v, the page and the date', () => {
    expect(parseLatestRelease(release())).toEqual({
      version: '0.2.0',
      url: PAGE,
      publishedUtc: '2026-11-01T12:00:00Z',
    });
  });

  it('refuses drafts, pre-releases and tags that are not plain versions', () => {
    expect(parseLatestRelease(release({ draft: true }))).toBeNull();
    expect(parseLatestRelease(release({ prerelease: true }))).toBeNull();
    expect(parseLatestRelease(release({ tag_name: 'v0.2.0-rc1' }))).toBeNull();
    expect(parseLatestRelease(release({ tag_name: 42 }))).toBeNull();
    expect(parseLatestRelease(null)).toBeNull();
    expect(parseLatestRelease('v0.2.0')).toBeNull();
  });

  it('refuses a page outside this repository’s releases', () => {
    expect(parseLatestRelease(release({ html_url: 'https://evil.example/terra-pulse' }))).toBeNull();
  });

  it('drops an unreadable date rather than the release', () => {
    expect(parseLatestRelease(release({ published_at: 'soon' }))?.publishedUtc).toBeNull();
  });
});

describe('isReleasePage', () => {
  it('accepts a release tag page', () => {
    expect(isReleasePage(PAGE)).toBe(true);
  });

  it('refuses look-alikes that a plain prefix match would let through', () => {
    for (const url of [
      'http://github.com/toddblack/terra-pulse/releases/tag/v0.2.0', // not https
      'https://github.com.evil.example/toddblack/terra-pulse/releases/tag/v0.2.0',
      'https://github.com/toddblack/terra-pulse/releases/tag/../../../evil/repo', // climbs out
      'https://github.com/toddblack/terra-pulse/releases/tag/', // no tag
      `${PAGE}?download=evil.exe`,
      `${PAGE}#x`,
      'https://github.com/someone-else/terra-pulse/releases/tag/v0.2.0',
      'javascript:alert(1)',
      'not a url',
    ]) {
      expect(isReleasePage(url), url).toBe(false);
    }
  });
});

describe('createUpdateChecker', () => {
  it('reports a newer release as available, asking GitHub as the app', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(release()));
    const { checker } = setUp(fetchImpl);

    const status = await checker.check();

    expect(status).toMatchObject({ state: 'available', latest: { version: '0.2.0' }, checkedAtUtc: '2026-11-02T00:00:00.000Z' });
    expect(checker.releaseUrl()).toBe(PAGE);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(LATEST_RELEASE_URL);
    expect(new Headers(init.headers).get('User-Agent')).toMatch(/^TerraPulse\//);
  });

  it('is up to date when the latest release is the running one, or older', async () => {
    for (const tag of ['v0.1.0', 'v0.0.9']) {
      const { checker } = setUp(vi.fn().mockResolvedValue(jsonResponse(release({ tag_name: tag }))));
      expect((await checker.check()).state).toBe('up-to-date');
      expect(checker.releaseUrl()).toBeNull();
    }
  });

  it('treats "no release yet" as up to date, and says so', async () => {
    const { checker } = setUp(vi.fn().mockResolvedValue(jsonResponse({ message: 'Not Found' }, 404)));
    expect(await checker.check()).toMatchObject({ state: 'up-to-date', latest: null, detail: 'No release has been published yet.' });
  });

  it('reports a refusal, an unreadable reply and an unreachable GitHub as failures, never throwing', async () => {
    const limited = setUp(vi.fn().mockResolvedValue(jsonResponse({ message: 'rate limit' }, 403)));
    expect(await limited.checker.check()).toMatchObject({ state: 'failed', detail: 'GitHub answered 403.' });

    const garbled = setUp(vi.fn().mockResolvedValue(jsonResponse({ tag_name: 'tomorrow' })));
    expect((await garbled.checker.check()).state).toBe('failed');

    const offline = setUp(vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    expect(await offline.checker.check()).toMatchObject({ state: 'failed', detail: 'Could not reach GitHub.' });
  });

  it('asks nothing while switched off', async () => {
    const fetchImpl = vi.fn();
    const { checker } = setUp(fetchImpl, { update_check_enabled: '0' });

    expect(checker.status()).toMatchObject({ enabled: false, state: 'off' });
    await checker.check();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('remembers the switch, and switching on asks at once', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(release()));
    const { checker, state } = setUp(fetchImpl);

    checker.setEnabled(false);
    expect(state.get('update_check_enabled')).toBe('0');
    expect(checker.status().state).toBe('off');

    checker.setEnabled(true);
    expect(state.has('update_check_enabled')).toBe(false); // absent means on
    await vi.waitFor(() => {
      expect(checker.status().state).toBe('available');
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('drops an answer that lands after the reader switched it off', async () => {
    let answer: (response: Response) => void = () => undefined;
    const fetchImpl = vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => {
        answer = resolve;
      }),
    );
    const { checker } = setUp(fetchImpl);

    const pending = checker.check();
    checker.setEnabled(false);
    answer(jsonResponse(release()));
    await pending;

    expect(checker.status()).toMatchObject({ state: 'off', latest: null });
    expect(checker.releaseUrl()).toBeNull();
  });

  it('shares one request between overlapping checks', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(release()));
    const { checker } = setUp(fetchImpl);

    await Promise.all([checker.check(), checker.check(), checker.check()]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('remembers a dismissal, and ignores one that is not a version', async () => {
    const { checker, state } = setUp(vi.fn().mockResolvedValue(jsonResponse(release())));
    await checker.check();

    checker.dismiss('nonsense');
    expect(state.has('update_dismissed_version')).toBe(false);

    checker.dismiss('0.2.0');
    expect(state.get('update_dismissed_version')).toBe('0.2.0');
    expect(checker.status().dismissedVersion).toBe('0.2.0');
    // Dismissing quiets the notice; the release is still there to open from the panel.
    expect(checker.releaseUrl()).toBe(PAGE);
  });

  it('reads a stored dismissal at start', () => {
    const { checker } = setUp(vi.fn(), { update_dismissed_version: '0.2.0' });
    expect(checker.status().dismissedVersion).toBe('0.2.0');
  });

  it('waits before the first check, then checks on the interval until disposed', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(release()));
    const { checker } = setUp(fetchImpl);

    checker.schedule(1_000, 10_000);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchImpl).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    checker.dispose();
    await vi.advanceTimersByTimeAsync(50_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('in the Store build, never asks GitHub and offers nothing to open', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(release()));
    const checker = createUpdateChecker({
      currentVersion: '0.1.0',
      channel: 'store',
      userAgent: 'TerraPulse/0.1.0',
      readState: () => null,
      writeState: () => undefined,
      fetchImpl,
    });

    expect(checker.status()).toMatchObject({ channel: 'store', state: 'store', enabled: false });
    checker.schedule(10, 10);
    await vi.advanceTimersByTimeAsync(1_000);
    await checker.check();
    checker.setEnabled(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(checker.releaseUrl()).toBeNull();
    expect(checker.status().state).toBe('store');
  });

  it('pushes each change of state', async () => {
    const { checker, pushes } = setUp(vi.fn().mockResolvedValue(jsonResponse(release())));
    await checker.check();
    expect(pushes).toEqual(['checking', 'available']);
  });
});
