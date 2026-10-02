import { ipcMain, shell } from 'electron';

/**
 * Hosts the renderer is allowed to ask the OS to open: USGS event pages;
 * anything else is a bug or an attempt.
 *
 * `api.nasa.gov` used to be here too, for the DONKI key modal's "get a key"
 * button. DONKI went keyless on 2026-09-30 and the modal went with it; a host
 * nothing links to is only surface, so it was removed rather than left.
 *
 * The URLs in question come from USGS data we fetched ourselves, so this
 * isn't guarding against a hostile source so much as making the boundary do
 * its job:
 * `shell.openExternal` hands a string to the operating system, and an
 * unvalidated one can carry non-http schemes that launch local programs.
 */
const ALLOWED_HOSTS = new Set(['earthquake.usgs.gov']);

export function isAllowedExternalUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  // Protocol check is the load-bearing one — it rejects file:, and the
  // shell-invoking schemes that make openExternal dangerous.
  if (url.protocol !== 'https:') return false;

  return ALLOWED_HOSTS.has(url.hostname);
}

export function registerExternalLinkIpcHandlers(): void {
  ipcMain.handle('shell:open-external', async (_event, rawUrl: unknown): Promise<boolean> => {
    if (typeof rawUrl !== 'string' || !isAllowedExternalUrl(rawUrl)) {
      console.warn('Refused to open external URL:', rawUrl);
      return false;
    }

    await shell.openExternal(rawUrl);
    return true;
  });
}
