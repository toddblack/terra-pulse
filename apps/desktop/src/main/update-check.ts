import { compareVersions, parseVersion, type ReleaseInfo, type UpdateStatus } from '@terra-pulse/schema';

/**
 * Asks GitHub whether a newer release exists. Notify only — see
 * `packages/schema/src/app-update.ts` for why it never installs anything.
 *
 * **Not on the startup path.** The first check waits until the window has been
 * up a while, and a failure is a line in the About panel, never an error: an
 * offline launch must look exactly like an online one.
 *
 * **What leaves the machine:** one unauthenticated GET to GitHub's API per
 * launch, then once a day while open. GitHub sees the IP address and the
 * User-Agent (`TerraPulse/<version>`), and nothing else. The About panel says
 * so beside the switch that turns it off.
 */

export const LATEST_RELEASE_URL = 'https://api.github.com/repos/toddblack/terra-pulse/releases/latest';

/**
 * The only pages the notice may open. The URL comes off the network and goes
 * to `shell.openExternal`, which hands it to the OS — so it is pinned to this
 * repository's release pages rather than trusted.
 */
export const RELEASE_PAGE_PREFIX = 'https://github.com/toddblack/terra-pulse/releases/tag/';

const ENABLED_KEY = 'update_check_enabled';
const DISMISSED_KEY = 'update_dismissed_version';

/** Long enough that a launch's own network work (backfill, first poll) goes first. */
export const FIRST_CHECK_DELAY_MS = 15_000;
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 10_000;

/**
 * The release GitHub calls latest, or null when its reply is not one we will
 * act on.
 *
 * Drafts and pre-releases never reach this endpoint, but they are refused
 * here too: the notice must only ever point at something deliberately
 * published.
 */
export function parseLatestRelease(json: unknown): ReleaseInfo | null {
  if (typeof json !== 'object' || json === null) return null;
  const record = json as Record<string, unknown>;
  if (record['draft'] === true || record['prerelease'] === true) return null;

  const tag = record['tag_name'];
  const page = record['html_url'];
  if (typeof tag !== 'string' || typeof page !== 'string') return null;
  const version = parseVersion(tag);
  if (version === null) return null;
  if (!isReleasePage(page)) return null;

  const published = record['published_at'];
  return {
    version: version.join('.'),
    url: page,
    publishedUtc: typeof published === 'string' && Number.isFinite(Date.parse(published)) ? published : null,
  };
}

/** One of this repository's release pages, over https, with nothing tacked on. */
export function isReleasePage(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  // Re-serialised and compared, so `https://github.com.evil.example/…` or a
  // path that climbs out with `..` cannot pass on a prefix match alone.
  return (
    url.protocol === 'https:' &&
    url.href.startsWith(RELEASE_PAGE_PREFIX) &&
    url.href.length > RELEASE_PAGE_PREFIX.length &&
    url.search === '' &&
    url.hash === ''
  );
}

export interface UpdateCheckerOptions {
  currentVersion: string;
  userAgent: string;
  readState: (key: string) => string | null;
  /** Null deletes the key. */
  writeState: (key: string, value: string | null) => void;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  onStatus?: (status: UpdateStatus) => void;
}

export interface UpdateChecker {
  status(): UpdateStatus;
  /** Asks GitHub now. Concurrent calls share one request. Off → returns at once. */
  check(): Promise<UpdateStatus>;
  setEnabled(enabled: boolean): UpdateStatus;
  dismiss(version: string): UpdateStatus;
  /** The release page to open, only while a newer release is known. */
  releaseUrl(): string | null;
  /** First check after `firstDelayMs`, then every `intervalMs`. Packaged builds only. */
  schedule(firstDelayMs?: number, intervalMs?: number): void;
  dispose(): void;
}

export function createUpdateChecker(options: UpdateCheckerOptions): UpdateChecker {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());

  let status: UpdateStatus = {
    currentVersion: options.currentVersion,
    // Absent means on. The check is useful by default and the panel offers the
    // switch; a stored '0' is the reader having said no.
    enabled: options.readState(ENABLED_KEY) !== '0',
    state: 'not-checked',
    latest: null,
    checkedAtUtc: null,
    dismissedVersion: options.readState(DISMISSED_KEY),
    detail: null,
  };
  if (!status.enabled) status = { ...status, state: 'off' };

  let inFlight: Promise<UpdateStatus> | null = null;
  const timers: ReturnType<typeof setTimeout>[] = [];

  function update(patch: Partial<UpdateStatus>): UpdateStatus {
    status = { ...status, ...patch };
    options.onStatus?.(status);
    return status;
  }

  async function ask(): Promise<UpdateStatus> {
    update({ state: 'checking', detail: null });
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, CHECK_TIMEOUT_MS);
    try {
      const response = await fetchImpl(LATEST_RELEASE_URL, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': options.userAgent,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: controller.signal,
      });
      const checkedAtUtc = now().toISOString();
      // A switch-off while the request was out wins: its answer is not wanted.
      if (!status.enabled) return status;

      if (response.status === 404) {
        return update({
          state: 'up-to-date',
          latest: null,
          checkedAtUtc,
          detail: 'No release has been published yet.',
        });
      }
      if (!response.ok) {
        // 403 here is almost always GitHub's limit of 60 unauthenticated
        // requests an hour per address — shared with anything else on the
        // network asking — so it is a "try later", not a fault.
        return update({ state: 'failed', checkedAtUtc, detail: `GitHub answered ${String(response.status)}.` });
      }

      const latest = parseLatestRelease(await response.json());
      if (latest === null) {
        return update({ state: 'failed', checkedAtUtc, detail: "GitHub's reply could not be read." });
      }
      const order = compareVersions(latest.version, options.currentVersion);
      if (order === null) {
        return update({ state: 'failed', checkedAtUtc, detail: 'The versions could not be compared.' });
      }
      return update({ state: order > 0 ? 'available' : 'up-to-date', latest, checkedAtUtc, detail: null });
    } catch (error: unknown) {
      if (!status.enabled) return status;
      const offline = error instanceof Error && error.name === 'AbortError' ? 'GitHub did not answer in time.' : null;
      return update({
        state: 'failed',
        checkedAtUtc: now().toISOString(),
        detail: offline ?? 'Could not reach GitHub.',
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  function check(): Promise<UpdateStatus> {
    if (!status.enabled) return Promise.resolve(status);
    inFlight ??= ask().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return {
    status: () => status,
    check,
    setEnabled: (enabled) => {
      options.writeState(ENABLED_KEY, enabled ? null : '0');
      if (!enabled) {
        return update({ enabled: false, state: 'off', latest: null, checkedAtUtc: null, detail: null });
      }
      update({ enabled: true, state: 'not-checked' });
      // Switching it on is asking for an answer.
      void check();
      return status;
    },
    dismiss: (version) => {
      if (parseVersion(version) === null) return status;
      options.writeState(DISMISSED_KEY, version);
      return update({ dismissedVersion: version });
    },
    releaseUrl: () => (status.state === 'available' && status.latest !== null ? status.latest.url : null),
    schedule: (firstDelayMs = FIRST_CHECK_DELAY_MS, intervalMs = CHECK_INTERVAL_MS) => {
      timers.push(
        setTimeout(() => {
          void check();
          timers.push(
            setInterval(() => {
              void check();
            }, intervalMs),
          );
        }, firstDelayMs),
      );
    },
    dispose: () => {
      for (const timer of timers) clearTimeout(timer);
      timers.length = 0;
    },
  };
}
