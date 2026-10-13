import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Usage for both engines, in one place.
 *
 * Claude: the CLI's `rate_limit_event` gives plan utilisation for the 5-hour and
 * 7-day windows; each turn's `result` gives cost and tokens.
 * Cursor: the CLI does not expose plan quota. `agent about --format json` gives the
 * plan tier and account; each turn's `result` gives tokens.
 */

export interface ClaudeWindows {
  fiveHour?: number;
  fiveHourResetsAt?: number;
  sevenDay?: number;
  sevenDayResetsAt?: number;
  /** `allowed`, `allowed_warning`, `rejected`… as the CLI reports it. */
  status?: string;
  /** The plan, e.g. "Claude Max", from the CLI's initialize reply. */
  plan?: string;
  updatedAt?: number;
}

export interface CursorAccount {
  /** The CLI's account: the one the panel's Cursor turns run on. */
  tier?: string;
  email?: string;
  /** False when `agent status` says the CLI is signed out. */
  signedIn?: boolean;
  cliVersion?: string;
  /** The Cursor app's account, which can differ from the CLI's. */
  appEmail?: string;
  appPlan?: string;
  appStatus?: string;
  updatedAt?: number;
}

export interface TurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

export interface UsageSnapshot {
  claude: ClaudeWindows;
  cursor: CursorAccount;
}

export function addUsage(a: TurnUsage | undefined, b: TurnUsage | undefined): TurnUsage {
  const sum = (x?: number, y?: number) => (x ?? 0) + (y ?? 0) || undefined;
  return {
    inputTokens: sum(a?.inputTokens, b?.inputTokens),
    outputTokens: sum(a?.outputTokens, b?.outputTokens),
    cacheReadTokens: sum(a?.cacheReadTokens, b?.cacheReadTokens),
    cacheWriteTokens: sum(a?.cacheWriteTokens, b?.cacheWriteTokens),
    costUsd: sum(a?.costUsd, b?.costUsd),
  };
}

export class UsageStore {
  private snapshot: UsageSnapshot;

  constructor(
    private readonly load: () => UsageSnapshot | undefined,
    private readonly persist: (s: UsageSnapshot) => void | Thenable<void>,
  ) {
    this.snapshot = load() ?? { claude: {}, cursor: {} };
  }

  get(): UsageSnapshot {
    return this.snapshot;
  }

  updateClaude(w: ClaudeWindows): void {
    this.snapshot = {
      ...this.snapshot,
      claude: { ...this.snapshot.claude, ...stripUndefined(w), updatedAt: Date.now() },
    };
    void this.persist(this.snapshot);
  }

  updateCursor(a: CursorAccount): void {
    this.snapshot = {
      ...this.snapshot,
      cursor: { ...this.snapshot.cursor, ...stripUndefined(a), updatedAt: Date.now() },
    };
    void this.persist(this.snapshot);
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** The Cursor app's signed-in account, from its settings store (email and plan only, never tokens). */
export function readCursorAppAccount(): Promise<Pick<CursorAccount, 'appEmail' | 'appPlan' | 'appStatus'>> {
  const db = join(homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  if (!existsSync(db)) return Promise.resolve({});
  return new Promise((resolve) => {
    execFile(
      'sqlite3',
      ['-readonly', '-json', '-cmd', '.timeout 2000', db, "select key, value from ItemTable where key in ('cursorAuth/cachedEmail','cursorAuth/stripeMembershipType','cursorAuth/stripeSubscriptionStatus')"],
      { timeout: 10_000 },
      (err, stdout) => {
        if (err) return resolve({});
        try {
          const rows = JSON.parse(stdout || '[]') as { key: string; value: string }[];
          const get = (k: string) => rows.find((r) => r.key === `cursorAuth/${k}`)?.value || undefined;
          resolve({ appEmail: get('cachedEmail'), appPlan: get('stripeMembershipType'), appStatus: get('stripeSubscriptionStatus') });
        } catch {
          resolve({});
        }
      },
    );
  });
}

/** Whether the CLI is signed in, from `agent status`. */
export function readCursorSignedIn(bin: string): Promise<boolean | undefined> {
  return new Promise((resolve) => {
    execFile(bin, ['status'], { timeout: 20_000 }, (err, stdout, stderr) => {
      const text = `${stdout}${stderr}`;
      if (/logged in as/i.test(text)) resolve(true);
      else if (/not logged in|logged out|login/i.test(text)) resolve(false);
      else resolve(undefined);
    });
  });
}

/** Plan tier and account from `agent about --format json`. */
export function readCursorAccount(bin: string): Promise<CursorAccount> {
  return new Promise((resolve) => {
    let out = '';
    const proc = spawn(bin, ['about', '--format', 'json'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => proc.kill('SIGTERM'), 20_000);
    proc.stdout.on('data', (b: Buffer) => {
      out += b.toString('utf8');
    });
    proc.on('error', () => {
      clearTimeout(timer);
      resolve({});
    });
    proc.on('exit', () => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out) as Record<string, unknown>;
        resolve({
          tier: typeof j.subscriptionTier === 'string' ? j.subscriptionTier : undefined,
          email: typeof j.userEmail === 'string' ? j.userEmail : undefined,
          cliVersion: typeof j.cliVersion === 'string' ? j.cliVersion : undefined,
        });
      } catch {
        resolve({});
      }
    });
  });
}
