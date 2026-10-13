import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const KEY = 'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser';

/**
 * Cursor's model catalog and your picker settings, read-only from its settings store:
 * `availableDefaultModels2` (models, their settings, descriptions) and `aiSettings`
 * (which models your picker shows, your last settings per model). Undefined when Cursor
 * isn't installed or the store can't be read.
 */
export function readCursorAppCatalog(): Promise<unknown | undefined> {
  const db = join(homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  if (!existsSync(db)) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(
      'sqlite3',
      ['-readonly', '-cmd', '.timeout 2000', db, `select value from ItemTable where key = '${KEY}'`],
      { timeout: 15_000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout.trim()) return resolve(undefined);
        try {
          const all = JSON.parse(stdout) as Record<string, unknown>;
          const ai = (all.aiSettings ?? {}) as Record<string, unknown>;
          resolve({
            availableDefaultModels2: all.availableDefaultModels2,
            aiSettings: {
              modelOverrideEnabled: ai.modelOverrideEnabled,
              modelOverrideDisabled: ai.modelOverrideDisabled,
              modelParameterPreferences: ai.modelParameterPreferences,
            },
          });
        } catch {
          resolve(undefined);
        }
      },
    );
  });
}
