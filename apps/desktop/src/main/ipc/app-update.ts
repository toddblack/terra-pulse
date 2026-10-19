import { ipcMain, shell } from 'electron';
import type { UpdateStatus } from '@terra-pulse/schema';
import type { UpdateChecker } from '../update-check';

/**
 * The update check over IPC. Status is pulled on mount and pushed on change
 * (`update:status-changed`), the same subscribe-then-pull shape as the watch.
 *
 * **The renderer never supplies a URL.** "Open the release page" opens the one
 * main fetched and validated (`isReleasePage`), so the external-link
 * allowlist does not need github.com on it, and a compromised renderer cannot
 * use this channel to open anything else.
 */
export function registerUpdateHandlers(checker: UpdateChecker): void {
  ipcMain.handle('update:status', (): UpdateStatus => checker.status());
  ipcMain.handle('update:check', (): Promise<UpdateStatus> => checker.check());
  ipcMain.handle('update:set-enabled', (_event, enabled: unknown): UpdateStatus => {
    if (typeof enabled !== 'boolean') throw new Error('update:set-enabled takes a boolean');
    return checker.setEnabled(enabled);
  });
  ipcMain.handle('update:dismiss', (_event, version: unknown): UpdateStatus => {
    if (typeof version !== 'string') throw new Error('update:dismiss takes a version string');
    return checker.dismiss(version);
  });
  ipcMain.handle('update:open-release', async (): Promise<boolean> => {
    const url = checker.releaseUrl();
    if (url === null) return false;
    await shell.openExternal(url);
    return true;
  });
}
