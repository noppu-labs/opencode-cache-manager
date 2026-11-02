import { EMPTY_TOTALS } from '../constants/savings.ts';
import type { LedgerTotals } from '../models/savings.ts';
import type { KV } from '../models/storage.ts';
import { isRecord } from '../utils/is-record.ts';

const LEDGER_KEY_PREFIX = 'ledger/';
const ledgerKey = (sessionID: string): string => `${LEDGER_KEY_PREFIX}${sessionID}`;

const COUNTER_FIELDS = [
  'pings',
  'rescues',
  'avoidedTokens',
  'pingUnits',
  'avoidedUnits',
  'pingUsd',
  'avoidedUsd',
  'unpricedEvents',
] as const;

/** Stored totals when well-formed; anything else is `EMPTY_TOTALS`. */
function parseTotals(stored: unknown): LedgerTotals {
  if (!isRecord(stored) || stored.version !== 1) return EMPTY_TOTALS;
  const values = COUNTER_FIELDS.map((field) => stored[field]);
  if (!values.every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)) {
    return EMPTY_TOTALS;
  }
  return {
    ...EMPTY_TOTALS,
    ...Object.fromEntries(COUNTER_FIELDS.map((field, index) => [field, values[index]])),
  };
}

/** Per-session savings totals, kept in memory and mirrored to plugin storage. */
class LedgerStore {
  private readonly totals = new Map<string, LedgerTotals>();
  private readonly loading = new Map<string, Promise<LedgerTotals>>();
  private readonly queues = new Map<string, Promise<unknown>>();

  public constructor(private readonly kv: KV) {}

  /** Loaded totals, or undefined before `load(sessionID)` settles. */
  public peek(sessionID: string): LedgerTotals | undefined {
    return this.totals.get(sessionID);
  }

  /** Loads once per session; corrupt or missing data loads as `EMPTY_TOTALS`. Never rejects. */
  public async load(sessionID: string): Promise<LedgerTotals> {
    const loaded = this.totals.get(sessionID);
    if (loaded !== undefined) return loaded;
    let pending = this.loading.get(sessionID);
    if (pending === undefined) {
      pending = this.read(sessionID);
      this.loading.set(sessionID, pending);
    }
    return pending;
  }

  /**
   * Applies `change` to the loaded totals and persists. Never rejects: a throwing `change`
   * leaves the totals as they were, and a persistence failure keeps memory.
   */
  public async update(
    sessionID: string,
    change: (totals: LedgerTotals) => LedgerTotals
  ): Promise<LedgerTotals> {
    const previous = this.queues.get(sessionID) ?? Promise.resolve();
    const run = previous.then(async () => {
      const current = await this.load(sessionID);
      let next: LedgerTotals;
      try {
        next = change(current);
      } catch {
        return current;
      }
      this.totals.set(sessionID, next);
      try {
        await this.kv.set(ledgerKey(sessionID), next);
      } catch {
        // The in-memory totals stay; only persistence is lost.
      }
      return next;
    });
    this.queues.set(
      sessionID,
      run.catch(() => {})
    );
    return run;
  }

  private async read(sessionID: string): Promise<LedgerTotals> {
    let totals = EMPTY_TOTALS;
    try {
      totals = parseTotals(await this.kv.get(ledgerKey(sessionID)));
    } catch {
      // Unreadable storage loads as empty.
    }
    this.totals.set(sessionID, totals);
    this.loading.delete(sessionID);
    return totals;
  }
}

export { LEDGER_KEY_PREFIX, LedgerStore };
