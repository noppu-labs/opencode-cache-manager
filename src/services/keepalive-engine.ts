import { BUILTIN_DEFAULTS, type Settings } from '../config/settings.ts';
import {
  DETECTABLE_TTLS,
  EXPIRY_MARGIN_MS,
  HIT_RATIO,
  PING_OFFSET_MS,
  RETRY_DELAY_MS,
  TTL_MS,
} from '../constants/keepalive.ts';
import type { CacheUsage, Ttl } from '../models/cache.ts';
import type {
  CacheReadout,
  KeepaliveSnapshot,
  RequestKind,
  SkipReason,
} from '../models/keepalive.ts';
import { contextTokens, grantedTtl, hasCacheActivity } from './usage.ts';

interface EngineDeps {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** Sends one ping; rejects on failure. */
  ping: (sessionID: string) => Promise<void>;
  settings: (sessionID: string) => Promise<Settings>;
  isChild: (sessionID: string) => Promise<boolean>;
  onChange: (snapshot: KeepaliveSnapshot) => void;
}

interface PingInFlight {
  firedAt: number;
  sentAt: number | null;
  contextBefore: number | null;
}

interface ResponseInfo {
  usage: CacheUsage | undefined;
  ok: boolean;
  isPing: boolean;
  kind: RequestKind;
  stopReason?: string;
  unmanaged?: boolean;
}

interface SessionState {
  ttl: Ttl | null;
  ttlSource: 'detected' | 'requested' | null;
  /** Null for sessions whose provider manages the cache itself. */
  requestedTtl: Ttl | null;
  lastRequestAt: number | null;
  /** Send time of the latest non-ping request, whether or not it has succeeded yet. */
  requestSentAt: number | null;
  /** Send time of the latest request (real or ping) the provider answered ok; the cache expiry is anchored here. */
  confirmedAt: number | null;
  nextPingAt: number | null;
  pingsUsed: number;
  maxPings: number;
  minContextTokens: number;
  lastPing: 'hit' | 'miss' | 'failed' | null;
  skipReason: SkipReason | null;
  contextTokens: number | null;
  lastCache: CacheReadout | null;
  cacheSeen: boolean;
  missed: boolean;
  /** The last primary response stopped for a tool call; cleared by the next real request. */
  busy: boolean;
  retryAt: number | null;
  inflight: PingInFlight | null;
  /** A `deps.ping` call that has not settled yet, whether or not its response was seen. */
  pingPending: boolean;
  /** A timer fired while `pingPending`; the schedule runs again once the call settles. */
  deferred: boolean;
  timer: { handle: unknown } | null;
  /** Bumped by every schedule and non-ping request; invalidates older timers and async computations. */
  generation: number;
  child: Promise<boolean> | undefined;
  lastEmitted: string;
}

class KeepaliveEngine {
  private readonly sessions = new Map<string, SessionState>();
  private disposed = false;

  public constructor(private readonly deps: EngineDeps) {}

  /** `kind` defaults to `primary`; only `primary` and `compaction` requests decide the session's requested TTL. */
  public requestSent(
    sessionID: string,
    info: { requestedTtl: Ttl | null; isPing: boolean; kind?: RequestKind }
  ): void {
    if (this.disposed) return;
    const state = this.state(sessionID);

    if (info.isPing) {
      if (state.inflight) state.inflight.sentAt = this.deps.now();
      return;
    }

    this.cancelTimer(state);
    state.generation++;
    state.inflight = null;
    state.lastRequestAt = this.deps.now();
    state.requestSentAt = state.lastRequestAt;
    const kind = info.kind ?? 'primary';
    if (kind === 'primary' || kind === 'compaction') {
      state.requestedTtl = info.requestedTtl;
      // A TTL usage cannot report means the session switched to a model whose cache the detected TTL does not describe.
      const requested = info.requestedTtl;
      if (
        state.ttlSource === 'detected' &&
        requested !== null &&
        requested !== state.ttl &&
        !DETECTABLE_TTLS.has(requested)
      ) {
        state.ttl = null;
        state.ttlSource = null;
      }
    }
    state.pingsUsed = 0;
    state.lastPing = null;
    state.missed = false;
    state.busy = false;
    state.retryAt = null;
    state.nextPingAt = null;
    if (state.skipReason === 'missed' || state.skipReason === 'exhausted') state.skipReason = null;
    // A stale `implicit` here would make the server drop the primary messages this request just stored.
    if (state.skipReason === 'implicit' && state.requestedTtl !== null) state.skipReason = null;
    this.commit(sessionID, state);
    void this.schedule(sessionID);
  }

  /** `unmanaged` on a primary or compaction response stops keeping the session warm until the next request sets a TTL. */
  public async responseObserved(sessionID: string, info: ResponseInfo): Promise<void> {
    if (this.disposed) return;
    const state = this.state(sessionID);
    if (
      info.unmanaged === true &&
      !info.isPing &&
      (info.kind === 'primary' || info.kind === 'compaction')
    ) {
      state.requestedTtl = null;
    }

    if (info.isPing) {
      await this.pingObserved(sessionID, state, info);
      return;
    }

    if (info.ok) {
      this.recordResponse(state, info);
    } else {
      // The request did not reach the cache, so the expiry goes back to the last confirmed request.
      state.lastRequestAt = state.confirmedAt;
    }
    this.commit(sessionID, state);
    await this.schedule(sessionID);
  }

  public async reevaluate(sessionID?: string): Promise<void> {
    if (this.disposed) return;
    const ids =
      sessionID === undefined
        ? [...this.sessions.keys()]
        : [sessionID].filter((id) => this.sessions.has(id));
    await Promise.all(ids.map(async (id) => this.schedule(id)));
  }

  public snapshot(sessionID: string): KeepaliveSnapshot {
    const state = this.sessions.get(sessionID);
    return state
      ? this.toSnapshot(sessionID, state)
      : this.toSnapshot(sessionID, this.newState(sessionID));
  }

  public dispose(): void {
    this.disposed = true;
    for (const state of this.sessions.values()) {
      this.cancelTimer(state);
      state.generation++;
      state.inflight = null;
    }
  }

  private async pingObserved(
    sessionID: string,
    state: SessionState,
    info: ResponseInfo
  ): Promise<void> {
    const { inflight } = state;
    if (!inflight) return;
    state.inflight = null;
    if (!info.ok || !info.usage) {
      await this.failPing(sessionID, state);
      return;
    }
    const { usage } = info;
    const before = inflight.contextBefore ?? contextTokens(usage);
    const hit = usage.cacheReadTokens >= HIT_RATIO * before;
    // A miss did not refresh the whole prefix, so the expiry stays anchored where it was.
    if (hit) {
      state.lastRequestAt = inflight.sentAt ?? inflight.firedAt;
      state.confirmedAt = state.lastRequestAt;
    }
    state.lastPing = hit ? 'hit' : 'miss';
    state.missed = !hit;
    state.retryAt = null;
    this.commit(sessionID, state);
    await this.schedule(sessionID);
  }

  /** Records a successful non-ping response: the expiry anchor, the cache readout and the learned TTL. */
  private recordResponse(state: SessionState, info: ResponseInfo): void {
    if (state.requestSentAt !== null) {
      state.confirmedAt = state.requestSentAt;
      state.lastRequestAt = state.requestSentAt;
    }
    if (info.usage && info.kind === 'primary') {
      const total = contextTokens(info.usage);
      state.lastCache = total > 0 ? { read: info.usage.cacheReadTokens, total } : null;
    }
    // Title and third-party generate calls use other prompts; they say nothing about this session's cache.
    if (info.usage && (info.kind === 'primary' || info.kind === 'compaction')) {
      state.contextTokens = contextTokens(info.usage);
      this.learn(state, info.usage);
    }
    if (info.kind === 'primary' && info.stopReason === 'tool_use') state.busy = true;
  }

  private state(sessionID: string): SessionState {
    let state = this.sessions.get(sessionID);
    if (!state) {
      state = this.newState(sessionID);
      this.sessions.set(sessionID, state);
    }
    return state;
  }

  private newState(sessionID: string): SessionState {
    const state: SessionState = {
      busy: false,
      cacheSeen: false,
      child: undefined,
      confirmedAt: null,
      contextTokens: null,
      deferred: false,
      generation: 0,
      inflight: null,
      lastCache: null,
      lastEmitted: '',
      lastPing: null,
      lastRequestAt: null,
      maxPings: BUILTIN_DEFAULTS.maxPings,
      minContextTokens: BUILTIN_DEFAULTS.minContextTokens,
      missed: false,
      nextPingAt: null,
      pingPending: false,
      pingsUsed: 0,
      requestSentAt: null,
      requestedTtl: null,
      retryAt: null,
      skipReason: 'no-cache-seen',
      timer: null,
      ttl: null,
      ttlSource: null,
    };
    state.lastEmitted = JSON.stringify(this.toSnapshot(sessionID, state));
    return state;
  }

  private toSnapshot(sessionID: string, state: SessionState): KeepaliveSnapshot {
    return {
      contextTokens: state.contextTokens,
      expiresAt:
        state.lastRequestAt !== null && state.ttl !== null
          ? state.lastRequestAt + TTL_MS[state.ttl]
          : null,
      lastCache: state.lastCache,
      lastPing: state.lastPing,
      lastRequestAt: state.lastRequestAt,
      maxPings: state.maxPings,
      minContextTokens: state.minContextTokens,
      nextPingAt: state.nextPingAt,
      pingsUsed: state.pingsUsed,
      sessionID,
      skipReason: state.skipReason,
      ttl: state.ttl,
      ttlSource: state.ttlSource,
    };
  }

  private commit(sessionID: string, state: SessionState): void {
    const snapshot = this.toSnapshot(sessionID, state);
    const serialized = JSON.stringify(snapshot);
    if (serialized === state.lastEmitted) return;
    state.lastEmitted = serialized;
    try {
      this.deps.onChange(snapshot);
    } catch {
      // A failing listener must not break scheduling.
    }
  }

  /** Updates cacheSeen and the TTL from a response that carries usage. */
  private learn(state: SessionState, usage: CacheUsage): void {
    const active = hasCacheActivity(usage);
    if (active) state.cacheSeen = true;
    const granted = grantedTtl(usage);
    if (granted) {
      state.ttl = granted;
      state.ttlSource = 'detected';
    } else if (active && state.requestedTtl !== null && state.ttlSource !== 'detected') {
      state.ttl = state.requestedTtl;
      state.ttlSource = 'requested';
    }
  }

  private cancelTimer(state: SessionState): void {
    if (!state.timer) return;
    this.deps.clearTimer(state.timer.handle);
    state.timer = null;
  }

  /** Cached once resolved; a failed lookup counts as a child for this computation only and is retried next time. */
  private async isChild(sessionID: string, state: SessionState): Promise<boolean> {
    if (!state.child) {
      const lookup = Promise.resolve().then(async () => this.deps.isChild(sessionID));
      state.child = lookup;
      lookup.catch(() => {
        if (state.child === lookup) state.child = undefined;
      });
    }
    return state.child.catch(() => true);
  }

  private async schedule(sessionID: string): Promise<void> {
    const state = this.state(sessionID);
    if (this.disposed || state.inflight) return;
    this.cancelTimer(state);
    const generation = ++state.generation;

    let settings: Settings;
    let child: boolean;
    try {
      [settings, child] = await Promise.all([
        this.deps.settings(sessionID),
        this.isChild(sessionID, state),
      ]);
    } catch {
      if (!this.disposed && state.generation === generation && state.inflight === null) {
        state.nextPingAt = null;
        this.commit(sessionID, state);
      }
      return;
    }
    if (this.disposed || state.generation !== generation || state.inflight !== null) return;

    state.maxPings = settings.maxPings;
    state.minContextTokens = settings.minContextTokens;
    state.skipReason = this.skipReason(state, settings, child);
    state.nextPingAt = state.skipReason === null ? this.pingTime(state) : null;

    if (state.nextPingAt !== null) {
      const delay = Math.max(0, state.nextPingAt - this.deps.now());
      state.timer = {
        handle: this.deps.setTimer(() => {
          this.fire(sessionID, generation);
        }, delay),
      };
    }
    this.commit(sessionID, state);
  }

  private skipReason(state: SessionState, settings: Settings, child: boolean): SkipReason | null {
    if (child) return 'child';
    if (state.requestedTtl === null) return 'implicit';
    if (state.busy) return 'busy';
    if (!settings.keepalive) return 'disabled';
    if (!state.cacheSeen || state.ttl === null || state.lastRequestAt === null) {
      return 'no-cache-seen';
    }
    if ((state.contextTokens ?? 0) < settings.minContextTokens) return 'small-context';
    if (state.missed) return 'missed';
    if (state.pingsUsed >= settings.maxPings) return 'exhausted';
    return null;
  }

  /** When the next ping is due, or null when it could not land before the cache expires. */
  private pingTime(state: SessionState): number | null {
    if (state.ttl === null || state.lastRequestAt === null) return null;
    const cutoff = state.lastRequestAt + TTL_MS[state.ttl] - EXPIRY_MARGIN_MS;
    const due =
      state.lastPing === 'failed' && state.retryAt !== null
        ? state.retryAt
        : state.lastRequestAt + PING_OFFSET_MS[state.ttl];
    if (due > cutoff || this.deps.now() > cutoff) return null;
    return due;
  }

  private fire(sessionID: string, generation: number): void {
    const state = this.sessions.get(sessionID);
    if (this.disposed || !state || state.generation !== generation) return;
    state.timer = null;

    if (state.pingPending) {
      state.deferred = true;
      return;
    }

    const now = this.deps.now();
    const expiresAt =
      state.lastRequestAt !== null && state.ttl !== null
        ? state.lastRequestAt + TTL_MS[state.ttl]
        : null;
    if (expiresAt === null || now > expiresAt - EXPIRY_MARGIN_MS) {
      state.nextPingAt = null;
      this.commit(sessionID, state);
      return;
    }

    state.pingsUsed++;
    state.nextPingAt = null;
    const inflight: PingInFlight = {
      contextBefore: state.contextTokens,
      firedAt: now,
      sentAt: null,
    };
    state.inflight = inflight;
    state.pingPending = true;
    this.commit(sessionID, state);

    const settled = (): void => {
      state.pingPending = false;
      if (this.disposed) return;
      /*
       * Resolved without a response seen, or rejected: unless a response (or a
       * newer real request) already settled this ping, it failed.
       */
      if (state.inflight === inflight) {
        state.inflight = null;
        state.deferred = false;
        void this.failPing(sessionID, state);
      } else if (state.deferred) {
        state.deferred = false;
        void this.schedule(sessionID);
      }
    };
    this.deps.ping(sessionID).then(settled, settled);
  }

  private async failPing(sessionID: string, state: SessionState): Promise<void> {
    state.lastPing = 'failed';
    state.retryAt = this.deps.now() + RETRY_DELAY_MS;
    this.commit(sessionID, state);
    await this.schedule(sessionID);
  }
}

export type { EngineDeps };
export { KeepaliveEngine };
