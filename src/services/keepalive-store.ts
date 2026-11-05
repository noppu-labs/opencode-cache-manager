import { TTL_MS } from '../constants/keepalive.ts';
import type { Ttl } from '../models/cache.ts';
import type { KeepaliveRecord } from '../models/keepalive.ts';
import type { KV } from '../models/storage.ts';
import { isNonEmptyString } from '../utils/is-non-empty-string.ts';
import { isRecord } from '../utils/is-record.ts';

const KEEPALIVE_KEY_PREFIX = 'keepalive/';
const RECORD_VERSION = 1;

/** Plugin storage, with the values a scan returns alongside its keys. */
interface KeepaliveKV extends KV {
  scan: (input: {
    prefix: string;
    after?: string;
  }) => Promise<{ entries: readonly { key: string; value: unknown }[]; next?: string }>;
}

/** Who is storing and restoring records: the instance's directory and its OpenCode server process. */
interface KeepaliveOwner {
  directory: string;
  pid: number;
  isAlive: (pid: number) => boolean;
}

interface StoredRecord {
  directory: string;
  pid: number;
  record: KeepaliveRecord;
}

interface RestorableSession {
  sessionID: string;
  record: KeepaliveRecord;
}

const isTtl = (value: unknown): value is Ttl =>
  typeof value === 'string' && Object.hasOwn(TTL_MS, value);
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isCountOrNull = (value: unknown): boolean => value === null || isCount(value);
const isBoolean = (value: unknown): boolean => typeof value === 'boolean';

const FIELD_CHECKS: Record<keyof KeepaliveRecord, (value: unknown) => boolean> = {
  contextTokens: isCountOrNull,
  firstPrimaryContext: isCountOrNull,
  lastCache: (value) =>
    value === null || (isRecord(value) && isCount(value.read) && isCount(value.total)),
  lastPing: (value) => value === null || value === 'hit' || value === 'miss' || value === 'failed',
  lastRequestAt: isCount,
  model: (value) =>
    value === null ||
    (isRecord(value) && typeof value.id === 'string' && typeof value.providerID === 'string'),
  originalExpiry: isCountOrNull,
  pingsUsed: isCount,
  prefix1hTokens: isCountOrNull,
  requestedTtl: isTtl,
  split: isBoolean,
  stretchCharged: isBoolean,
  stretchHits: isCount,
  ttl: isTtl,
  ttlSource: (value) => value === null || value === 'detected' || value === 'requested',
};
const isRecordField = (key: string): key is keyof KeepaliveRecord => key in FIELD_CHECKS;
const RECORD_FIELDS = Object.keys(FIELD_CHECKS).filter((key) => isRecordField(key));

function parseStored(stored: unknown): StoredRecord | undefined {
  if (!isRecord(stored) || stored.version !== RECORD_VERSION) return undefined;
  if (typeof stored.directory !== 'string' || !isCount(stored.pid)) return undefined;
  if (!RECORD_FIELDS.every((field) => FIELD_CHECKS[field](stored[field]))) return undefined;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- FIELD_CHECKS above validated every field of the record
  const record = Object.fromEntries(
    RECORD_FIELDS.map((field) => [field, stored[field]])
  ) as unknown as KeepaliveRecord;
  return { directory: stored.directory, pid: stored.pid, record };
}

/**
 * Per-session keepalive records in plugin storage, so a schedule outlives a plugin reload.
 *
 * Every OpenCode process on the machine shares this storage and each runs its own timers, so a
 * record has exactly one owner: resuming another's session would ping it a second time. A record
 * names the process and directory that wrote it. A reload keeps the process, so its record is
 * still its own; a restart leaves a dead process behind, whose records its directory's next
 * instance claims; a record of any other running process is left alone.
 */
class KeepaliveStore {
  private readonly queues = new Map<string, Promise<void>>();

  public constructor(
    private readonly kv: KeepaliveKV,
    private readonly owner: KeepaliveOwner
  ) {}

  public save(sessionID: string, record: KeepaliveRecord): void {
    this.enqueue(sessionID, async () =>
      this.kv.set(`${KEEPALIVE_KEY_PREFIX}${sessionID}`, this.stored(record))
    );
  }

  public remove(sessionID: string): void {
    this.enqueue(sessionID, async () => this.kv.remove(`${KEEPALIVE_KEY_PREFIX}${sessionID}`));
  }

  /** This directory's records whose cache may still be alive; drops malformed and expired ones. Never rejects. */
  public async restorable(now: number): Promise<RestorableSession[]> {
    const restorable: RestorableSession[] = [];
    try {
      let after: string | undefined;
      do {
        const page = await this.kv.scan({
          prefix: KEEPALIVE_KEY_PREFIX,
          ...(isNonEmptyString(after) ? { after } : {}),
        });
        for (const { key, value } of page.entries) {
          const parsed = parseStored(value);
          if (!parsed || parsed.record.lastRequestAt + TTL_MS[parsed.record.ttl] <= now) {
            await this.kv.remove(key);
          } else if (await this.takeOwnership(key, parsed)) {
            restorable.push({
              record: parsed.record,
              sessionID: key.slice(KEEPALIVE_KEY_PREFIX.length),
            });
          }
        }
        after = page.next;
      } while (isNonEmptyString(after));
    } catch {
      // Whatever was read still restores; the rest waits for the session's next request.
    }
    return restorable;
  }

  /** True when the record is this process's to resume, claiming it first if its owner has gone. */
  private async takeOwnership(
    key: string,
    { directory, pid, record }: StoredRecord
  ): Promise<boolean> {
    if (directory !== this.owner.directory) return false;
    if (pid === this.owner.pid) return true;
    if (this.owner.isAlive(pid)) return false;
    await this.kv.set(key, this.stored(record));
    return true;
  }

  private stored(record: KeepaliveRecord): Record<string, unknown> {
    return {
      ...record,
      directory: this.owner.directory,
      pid: this.owner.pid,
      version: RECORD_VERSION,
    };
  }

  /** Writes for one session run in order, so a slow save cannot land after the remove that followed it. */
  private enqueue(sessionID: string, write: () => Promise<void>): void {
    const previous = this.queues.get(sessionID) ?? Promise.resolve();
    this.queues.set(
      sessionID,
      previous.then(write).catch(() => {})
    );
  }
}

export type { KeepaliveKV, KeepaliveOwner, RestorableSession };
export { KEEPALIVE_KEY_PREFIX, KeepaliveStore };
