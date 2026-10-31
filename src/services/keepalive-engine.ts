import { BUILTIN_DEFAULTS, type Settings } from '../config/settings.ts';
import {
  DETECTABLE_TTLS,
  EXPIRY_MARGIN_MS,
  HIT_RATIO,
  PING_OFFSET_MS,
  RETRY_DELAY_MS,
  TTL_MS,
} from '../constants/keepalive.ts';
import { OPENAI_TTLS } from '../constants/openai.ts';
import { SAVINGS_EXPIRY_MARGIN_MS } from '../constants/savings.ts';
import type { CacheUsage, ModelRef, Ttl } from '../models/cache.ts';
import type {
  CacheReadout,
  KeepaliveSnapshot,
  RequestKind,
  SkipReason,
} from '../models/keepalive.ts';
import type { SavingsReadout } from '../models/savings.ts';
import type { SavingsLedger } from './savings-ledger.ts';
import { contextTokens, grantedTtl, hasCacheActivity } from './usage.ts';

type EngineLedger = Pick<
  SavingsLedger,
  'stretchStarted' | 'pingCharged' | 'stretchRescued' | 'readout'
>;

interface EngineDeps {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** Sends one ping; rejects on failure. */
  ping: (sessionID: string) => Promise<void>;
  settings: (sessionID: string) => Promise<Settings>;
  isChild: (sessionID: string) => Promise<boolean>;
  onChange: (snapshot: KeepaliveSnapshot) => void;
  /** Told of charged pings and rescued stretches; never awaited. */
  savings?: EngineLedger;
}

/** `split`: the active mode is `hybrid` on a managed profile. */
interface RequestInfo {
  requestedTtl: Ttl | null;
  isPing: boolean;
  kind?: RequestKind;
  split?: boolean;
  model?: ModelRef;
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
  model?: ModelRef;
  /** The model the response named. */
  reportedModel?: string;
}

/** A return request that may rescue its stretch, decided by its response. */
interface PendingReturn {
  contextBefore: number;
  ttl: Ttl;
  /** Tokens of the long-lived prefix on a split cache; null when unknown. */
  prefix: number | null;
  split: boolean;
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
  /** The latest resolved child lookup; null before one resolves. */
  childResult: boolean | null;
  lastEmitted: string;
  showSavings: boolean;
  /** When the cache expires without pings: the latest real primary or compaction confirmation plus its TTL. */
  originalExpiry: number | null;
  /** Hit pings since the latest real request. */
  stretchHits: number;
  /** A ping was charged since the ledger last heard of a new stretch. */
  stretchCharged: boolean;
  /** The TTL the latest ping was sent on, which its cost is charged at. */
  pingTtl: Ttl | null;
  /** The latest primary or compaction request ran in `hybrid` mode. */
  split: boolean;
  /** Claude split prefix: the largest 1h write of a primary or compaction response. */
  prefix1hTokens: number | null;
  /** OpenAI split prefix: the context of the first primary response on an OpenAI TTL. */
  firstPrimaryContext: number | null;
  pendingReturn: PendingReturn | null;
  model: ModelRef | null;
}

class KeepaliveEngine {
  private readonly sessions = new Map<string, SessionState>();
  private disposed = false;

  public constructor(private readonly deps: EngineDeps) {}

  /** `kind` defaults to `primary`; only `primary` and `compaction` requests decide the session's requested TTL. */
  public requestSent(sessionID: string, info: RequestInfo): void {
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
    const sessionTurn = kind === 'primary' || kind === 'compaction';
    // Any earlier pending return is overtaken by this request.
    state.pendingReturn = sessionTurn
      ? this.returnCheck(state, state.lastRequestAt, info.split === true)
      : null;
    this.startStretch(sessionID, state);
    if (sessionTurn) {
      state.split = info.split === true;
      if (info.model) state.model = info.model;
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
      this.recordResponse(sessionID, state, info);
    } else {
      // The request did not reach the cache, so the expiry goes back to the last confirmed request.
      state.lastRequestAt = state.confirmedAt;
      state.pendingReturn = null;
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

  /** Re-commits the session's snapshot, emitting it only if it changed (a new ledger readout). */
  public refresh(sessionID: string): void {
    if (this.disposed) return;
    const state = this.sessions.get(sessionID);
    if (state) this.commit(sessionID, state);
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
    // Charged even when a real request already ended the ping's stretch: it was still billed.
    if (info.usage) this.chargePing(sessionID, state, info.usage, info);
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
      state.stretchHits++;
    }
    state.lastPing = hit ? 'hit' : 'miss';
    state.missed = !hit;
    state.retryAt = null;
    this.commit(sessionID, state);
    await this.schedule(sessionID);
  }

  /** Records a successful non-ping response: the expiry anchor, the cache readout, the learned TTL and a rescue. */
  private recordResponse(sessionID: string, state: SessionState, info: ResponseInfo): void {
    const pending = state.pendingReturn;
    state.pendingReturn = null;
    if (state.requestSentAt !== null) {
      state.confirmedAt = state.requestSentAt;
      state.lastRequestAt = state.requestSentAt;
    }
    if (info.usage && info.kind === 'primary') {
      const total = contextTokens(info.usage);
      state.lastCache = total > 0 ? { read: info.usage.cacheReadTokens, total } : null;
    }
    // Title and third-party generate calls use other prompts; they say nothing about this session's cache.
    const sessionTurn = info.kind === 'primary' || info.kind === 'compaction';
    if (info.usage && sessionTurn) {
      state.contextTokens = contextTokens(info.usage);
      this.learn(state, info.usage);
      this.learnPrefix(state, info.usage, info.kind);
      if (pending) this.resolveReturn(sessionID, state, pending, info);
    }
    if (sessionTurn) {
      state.originalExpiry =
        state.ttl === null || state.confirmedAt === null
          ? null
          : state.confirmedAt + TTL_MS[state.ttl];
    }
    if (info.kind === 'primary' && info.stopReason === 'tool_use') state.busy = true;
  }

  private learnPrefix(state: SessionState, usage: CacheUsage, kind: RequestKind): void {
    if (state.requestedTtl !== null && OPENAI_TTLS.has(state.requestedTtl)) {
      const context = contextTokens(usage);
      // A zero context says nothing about the prefix; subtracting it would count the whole read.
      if (kind === 'primary' && state.firstPrimaryContext === null && context > 0) {
        state.firstPrimaryContext = context;
      }
    } else {
      // A later turn may rewrite only the tail of the prefix; the largest write errs toward fewer avoided tokens.
      const write1h = usage.write1hTokens ?? 0;
      if (write1h > 0) state.prefix1hTokens = Math.max(state.prefix1hTokens ?? 0, write1h);
    }
  }

  /**
   * A real primary or compaction request may rescue its stretch when the stretch had a hit
   * ping and the request goes out past the margin after the cache would have expired without pings.
   */
  private returnCheck(state: SessionState, now: number, split: boolean): PendingReturn | null {
    if (
      state.stretchHits === 0 ||
      state.originalExpiry === null ||
      now <= state.originalExpiry + SAVINGS_EXPIRY_MARGIN_MS
    ) {
      return null;
    }
    if (state.ttl === null || state.contextTokens === null) return null;
    const openai = state.requestedTtl !== null && OPENAI_TTLS.has(state.requestedTtl);
    return {
      contextBefore: state.contextTokens,
      prefix: openai ? state.firstPrimaryContext : state.prefix1hTokens,
      // Either side being split means the long-lived prefix may have stayed warm on its own.
      split: state.split || split,
      ttl: state.ttl,
    };
  }

  /** Reports the rescue when the return read the cache warm; a split cache counts only the part past the prefix. */
  private resolveReturn(
    sessionID: string,
    state: SessionState,
    pending: PendingReturn,
    info: ResponseInfo
  ): void {
    const { usage } = info;
    const ref = info.model ?? state.model;
    if (!usage || !ref || usage.cacheReadTokens < HIT_RATIO * pending.contextBefore) return;
    let avoided = usage.cacheReadTokens;
    if (pending.split) avoided = pending.prefix === null ? 0 : avoided - pending.prefix;
    if (avoided <= 0) return;
    const model = { ref, reportedModel: info.reportedModel };
    const returnContext = contextTokens(usage);
    this.report(async (ledger) =>
      ledger.stretchRescued(sessionID, model, avoided, pending.ttl, returnContext)
    );
  }

  private chargePing(
    sessionID: string,
    state: SessionState,
    usage: CacheUsage,
    info: ResponseInfo
  ): void {
    const ref = info.model ?? state.model;
    const ttl = state.pingTtl;
    if (!ref || ttl === null) return;
    state.stretchCharged = true;
    const model = { ref, reportedModel: info.reportedModel };
    this.report(async (ledger) => ledger.pingCharged(sessionID, model, usage, ttl));
  }

  /** A real request ends the stretch; the ledger only needs to hear of it after a charged ping. */
  private startStretch(sessionID: string, state: SessionState): void {
    state.stretchHits = 0;
    if (!state.stretchCharged) return;
    state.stretchCharged = false;
    this.report((ledger) => {
      ledger.stretchStarted(sessionID);
    });
  }

  /** Fire and forget: a ledger call never blocks or breaks scheduling. */
  private report(call: (ledger: EngineLedger) => Promise<void> | void): void {
    const ledger = this.deps.savings;
    if (!ledger) return;
    try {
      void Promise.resolve(call(ledger)).catch(() => {});
    } catch {
      // A failing ledger must not break scheduling.
    }
  }

  /** Only managed, non-child sessions with savings shown read the ledger; any other read would load it for nothing. */
  private readout(sessionID: string, state: SessionState): SavingsReadout | null {
    if (
      !this.deps.savings ||
      !state.showSavings ||
      state.childResult !== false ||
      state.requestedTtl === null
    ) {
      return null;
    }
    try {
      return this.deps.savings.readout(sessionID);
    } catch {
      return null;
    }
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
      childResult: null,
      confirmedAt: null,
      contextTokens: null,
      deferred: false,
      firstPrimaryContext: null,
      generation: 0,
      inflight: null,
      lastCache: null,
      lastEmitted: '',
      lastPing: null,
      lastRequestAt: null,
      maxPings: BUILTIN_DEFAULTS.maxPings,
      minContextTokens: BUILTIN_DEFAULTS.minContextTokens,
      missed: false,
      model: null,
      nextPingAt: null,
      originalExpiry: null,
      pendingReturn: null,
      pingPending: false,
      pingTtl: null,
      pingsUsed: 0,
      prefix1hTokens: null,
      requestSentAt: null,
      requestedTtl: null,
      retryAt: null,
      showSavings: BUILTIN_DEFAULTS.savings,
      skipReason: 'no-cache-seen',
      split: false,
      stretchCharged: false,
      stretchHits: 0,
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
      savings: this.readout(sessionID, state),
      sessionID,
      showSavings: state.showSavings,
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

    state.childResult = child;
    state.maxPings = settings.maxPings;
    state.minContextTokens = settings.minContextTokens;
    state.showSavings = settings.savings;
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
    state.pingTtl = state.ttl;
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

export type { EngineDeps, RequestInfo, ResponseInfo };
export { KeepaliveEngine };
