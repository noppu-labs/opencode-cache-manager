import { EMPTY_TOTALS } from '../constants/savings.ts';
import type { LedgerTotals } from '../models/savings.ts';
import type { KV } from '../models/storage.ts';
import { isRecord } from '../utils/is-record.ts';

const LEDGER_KEY_PREFIX = 'ledger/';
const ledgerKey = (sessionID: string): string => `${LEDGER_KEY_PREFIX}${sessionID}`;

type CounterField = Exclude<keyof LedgerTotals, 'version'>;

// A Record, so a counter added to LedgerTotals fails to compile until it is listed here.
const COUNTERS: Record<CounterField, true> = {
  avoidedTokens: true,
  avoidedUnits: true,
  avoidedUsd: true,
  pingUnits: true,
  pingUsd: true,
  pings: true,
  rescues: true,
  unpricedEvents: true,
};
const isCounterField = (key: string): key is CounterField => key in COUNTERS;
const COUNTER_FIELDS = Object.keys(COUNTERS).filter((key) => isCounterField(key));

type Change = (totals: LedgerTotals) => LedgerTotals;

/** `change` applied to `totals`; a throwing change leaves them as they were. */
function applyChange(totals: LedgerTotals, change: Change): LedgerTotals {
  try {
    return change(totals);
  } catch {
    return totals;
  }
}

/** `changes` applied in order; a throwing change is skipped. */
function applyAll(totals: LedgerTotals, changes: readonly Change[]): LedgerTotals {
  let result = totals;
  for (const change of changes) result = applyChange(result, change);
  return result;
}

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
  private readonly loading = new Map<string, Promise<LedgerTotals | undefined>>();
  private readonly queues = new Map<string, Promise<unknown>>();
  /** Changes made while the stored record was unreadable, applied once a read succeeds. */
  private readonly deferred = new Map<string, Change[]>();

  public constructor(private readonly kv: KV) {}

  /** Loaded totals, or undefined before `load(sessionID)` settles. */
  public peek(sessionID: string): LedgerTotals | undefined {
    return this.totals.get(sessionID);
  }

  /**
   * Loads once per session; corrupt or missing data loads as `EMPTY_TOTALS`. Never rejects.
   * A storage read error resolves as `EMPTY_TOTALS` without caching it, so the next call retries.
   */
  public async load(sessionID: string): Promise<LedgerTotals> {
    return (await this.fetch(sessionID)) ?? EMPTY_TOTALS;
  }

  /**
   * Applies `change` to the loaded totals and persists. Never rejects: a throwing `change`
   * leaves the totals as they were, and a persistence failure keeps memory. While the stored
   * record is unreadable the change is held back and nothing is written, so a stored record is
   * never overwritten blind; held changes apply on the first update after a successful read.
   */
  public async update(sessionID: string, change: Change): Promise<LedgerTotals> {
    const previous = this.queues.get(sessionID) ?? Promise.resolve();
    const run = previous.then(async () => {
      const current = await this.fetch(sessionID);
      const held = this.deferred.get(sessionID) ?? [];
      if (current === undefined) {
        this.deferred.set(sessionID, [...held, change]);
        return applyAll(EMPTY_TOTALS, [...held, change]);
      }
      this.deferred.delete(sessionID);
      const next = applyAll(current, [...held, change]);
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

  private async fetch(sessionID: string): Promise<LedgerTotals | undefined> {
    const loaded = this.totals.get(sessionID);
    if (loaded !== undefined) return loaded;
    let pending = this.loading.get(sessionID);
    if (pending === undefined) {
      pending = this.read(sessionID);
      this.loading.set(sessionID, pending);
    }
    return pending;
  }

  /** The stored totals, or undefined when storage could not be read (nothing is cached then). */
  private async read(sessionID: string): Promise<LedgerTotals | undefined> {
    try {
      // Yield first so `fetch` registers this promise in `loading` before the `finally` clears it. Without it a synchronous `kv.get` throw would clear first and leave a stale entry.
      await Promise.resolve();
      const totals = parseTotals(await this.kv.get(ledgerKey(sessionID)));
      this.totals.set(sessionID, totals);
      return totals;
    } catch {
      return undefined;
    } finally {
      this.loading.delete(sessionID);
    }
  }
}

export { LEDGER_KEY_PREFIX, LedgerStore };
