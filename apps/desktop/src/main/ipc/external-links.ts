import { ipcMain, shell } from 'electron';

/**
 * Hosts the renderer is allowed to ask the OS to open. Everything the app
 * links to today is a USGS event page; anything else is a bug or an attempt.
 *
 * The URLs in question come from USGS data we fetched ourselves, so this isn't
 * guarding against a hostile source so much as making the boundary do its job:
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
