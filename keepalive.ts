import { contextTokens, grantedTtl, hasCacheActivity, type CacheUsage, type Ttl } from "./usage.ts";
import { BUILTIN_DEFAULTS, type Settings } from "./settings.ts";

export const TTL_MS: Record<Ttl, number> = { "5m": 300_000, "1h": 3_600_000 };
export const PING_OFFSET_MS: Record<Ttl, number> = { "5m": 240_000, "1h": 3_000_000 };
export const HIT_RATIO = 0.9;
export const RETRY_DELAY_MS = 30_000;
/** A ping is never sent later than `expiresAt - EXPIRY_MARGIN_MS`. */
export const EXPIRY_MARGIN_MS = 15_000;
export const PING_PROMPT = "Do not perform any work and do not use tools. Reply with exactly: OK";

export type SkipReason = "disabled" | "small-context" | "child" | "exhausted" | "no-cache-seen" | "missed";

export interface KeepaliveSnapshot {
  sessionID: string;
  ttl: Ttl | null;
  ttlSource: "detected" | "requested" | null;
  lastRequestAt: number | null;
  expiresAt: number | null;
  nextPingAt: number | null;
  pingsUsed: number;
  maxPings: number;
  minContextTokens: number;
  lastPing: "hit" | "miss" | "failed" | null;
  skipReason: SkipReason | null;
  contextTokens: number | null;
}

export interface EngineDeps {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Sends one ping; rejects on failure. */
  ping(sessionID: string): Promise<void>;
  settings(sessionID: string): Promise<Settings>;
  isChild(sessionID: string): Promise<boolean>;
  onChange(snapshot: KeepaliveSnapshot): void;
}

interface PingInFlight {
  firedAt: number;
  sentAt: number | null;
  contextBefore: number | null;
}

interface SessionState {
  ttl: Ttl | null;
  ttlSource: "detected" | "requested" | null;
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
  lastPing: "hit" | "miss" | "failed" | null;
  skipReason: SkipReason | null;
  contextTokens: number | null;
  cacheSeen: boolean;
  missed: boolean;
  retryAt: number | null;
  inflight: PingInFlight | null;
  timer: { handle: unknown } | null;
  /** Bumped by every schedule and non-ping request; invalidates older timers and async computations. */
  generation: number;
  child: Promise<boolean> | undefined;
  lastEmitted: string;
}

export class KeepaliveEngine {
  private readonly sessions = new Map<string, SessionState>();
  private disposed = false;

  constructor(private readonly deps: EngineDeps) {}

  requestSent(sessionID: string, info: { requestedTtl: Ttl; isPing: boolean }): void {
    if (this.disposed) return;
    const s = this.state(sessionID);

    if (info.isPing) {
      if (s.inflight) s.inflight.sentAt = this.deps.now();
      return;
    }

    this.cancelTimer(s);
    s.generation++;
    s.inflight = null;
    s.lastRequestAt = this.deps.now();
    s.requestSentAt = s.lastRequestAt;
    s.requestedTtl = info.requestedTtl;
    s.pingsUsed = 0;
    s.lastPing = null;
    s.missed = false;
    s.retryAt = null;
    s.nextPingAt = null;
    if (s.skipReason === "missed" || s.skipReason === "exhausted") s.skipReason = null;
    this.commit(sessionID, s);
    void this.schedule(sessionID);
  }

  async responseObserved(
    sessionID: string,
    info: { usage: CacheUsage | undefined; ok: boolean; isPing: boolean },
  ): Promise<void> {
    if (this.disposed) return;
    const s = this.state(sessionID);

    if (info.isPing) {
      const inflight = s.inflight;
      if (!inflight) return;
      s.inflight = null;
      if (!info.ok || !info.usage) {
        await this.failPing(sessionID, s);
        return;
      }
      const usage = info.usage;
      s.lastRequestAt = inflight.sentAt ?? inflight.firedAt;
      s.confirmedAt = s.lastRequestAt;
      const before = inflight.contextBefore ?? contextTokens(usage);
      const hit = usage.cacheReadTokens >= HIT_RATIO * before;
      s.lastPing = hit ? "hit" : "miss";
      s.missed = !hit;
      s.retryAt = null;
      this.learn(s, usage);
      this.commit(sessionID, s);
      await this.schedule(sessionID);
      return;
    }

    if (!info.ok) {
      // The request did not reach the cache, so the expiry goes back to the last confirmed request.
      s.lastRequestAt = s.confirmedAt;
      this.commit(sessionID, s);
      await this.schedule(sessionID);
      return;
    }
    if (s.requestSentAt !== null) {
      s.confirmedAt = s.requestSentAt;
      s.lastRequestAt = s.requestSentAt;
    }
    if (info.usage) {
      s.contextTokens = contextTokens(info.usage);
      this.learn(s, info.usage);
    }
    this.commit(sessionID, s);
    await this.schedule(sessionID);
  }

  async reevaluate(sessionID?: string): Promise<void> {
    if (this.disposed) return;
    const ids = sessionID === undefined ? [...this.sessions.keys()] : this.sessions.has(sessionID) ? [sessionID] : [];
    await Promise.all(ids.map((id) => this.schedule(id)));
  }

  snapshot(sessionID: string): KeepaliveSnapshot {
    const s = this.sessions.get(sessionID);
    return s ? this.toSnapshot(sessionID, s) : this.toSnapshot(sessionID, this.newState(sessionID));
  }

  dispose(): void {
    this.disposed = true;
    for (const s of this.sessions.values()) {
      this.cancelTimer(s);
      s.generation++;
      s.inflight = null;
    }
  }

  private state(sessionID: string): SessionState {
    let s = this.sessions.get(sessionID);
    if (!s) {
      s = this.newState(sessionID);
      this.sessions.set(sessionID, s);
    }
    return s;
  }

  private newState(sessionID: string): SessionState {
    const s: SessionState = {
      ttl: null,
      ttlSource: null,
      requestedTtl: null,
      lastRequestAt: null,
      requestSentAt: null,
      confirmedAt: null,
      nextPingAt: null,
      pingsUsed: 0,
      maxPings: BUILTIN_DEFAULTS.maxPings,
      minContextTokens: BUILTIN_DEFAULTS.minContextTokens,
      lastPing: null,
      skipReason: "no-cache-seen",
      contextTokens: null,
      cacheSeen: false,
      missed: false,
      retryAt: null,
      inflight: null,
      timer: null,
      generation: 0,
      child: undefined,
      lastEmitted: "",
    };
    s.lastEmitted = JSON.stringify(this.toSnapshot(sessionID, s));
    return s;
  }

  private toSnapshot(sessionID: string, s: SessionState): KeepaliveSnapshot {
    return {
      sessionID,
      ttl: s.ttl,
      ttlSource: s.ttlSource,
      lastRequestAt: s.lastRequestAt,
      expiresAt: s.lastRequestAt !== null && s.ttl !== null ? s.lastRequestAt + TTL_MS[s.ttl] : null,
      nextPingAt: s.nextPingAt,
      pingsUsed: s.pingsUsed,
      maxPings: s.maxPings,
      minContextTokens: s.minContextTokens,
      lastPing: s.lastPing,
      skipReason: s.skipReason,
      contextTokens: s.contextTokens,
    };
  }

  private commit(sessionID: string, s: SessionState): void {
    const snapshot = this.toSnapshot(sessionID, s);
    const serialized = JSON.stringify(snapshot);
    if (serialized === s.lastEmitted) return;
    s.lastEmitted = serialized;
    try {
      this.deps.onChange(snapshot);
    } catch {
      // A failing listener must not break scheduling.
    }
  }

  /** Updates cacheSeen and the TTL from a response that carries usage. */
  private learn(s: SessionState, usage: CacheUsage): void {
    const active = hasCacheActivity(usage);
    if (active) s.cacheSeen = true;
    const granted = grantedTtl(usage);
    if (granted) {
      s.ttl = granted;
      s.ttlSource = "detected";
    } else if (active && s.ttl === null && s.requestedTtl !== null) {
      s.ttl = s.requestedTtl;
      s.ttlSource = "requested";
    }
  }

  private cancelTimer(s: SessionState): void {
    if (!s.timer) return;
    this.deps.clearTimer(s.timer.handle);
    s.timer = null;
  }

  /** Cached once resolved; a failed lookup counts as a child for this computation only and is retried next time. */
  private isChild(sessionID: string, s: SessionState): Promise<boolean> {
    if (!s.child) {
      const lookup = Promise.resolve().then(() => this.deps.isChild(sessionID));
      s.child = lookup;
      lookup.catch(() => {
        if (s.child === lookup) s.child = undefined;
      });
    }
    return s.child.catch(() => true);
  }

  private async schedule(sessionID: string): Promise<void> {
    const s = this.state(sessionID);
    if (this.disposed || s.inflight) return;
    this.cancelTimer(s);
    const generation = ++s.generation;

    let settings: Settings;
    let child: boolean;
    try {
      [settings, child] = await Promise.all([this.deps.settings(sessionID), this.isChild(sessionID, s)]);
    } catch {
      if (!this.disposed && s.generation === generation && !s.inflight) {
        s.nextPingAt = null;
        this.commit(sessionID, s);
      }
      return;
    }
    if (this.disposed || s.generation !== generation || s.inflight) return;

    s.maxPings = settings.maxPings;
    s.minContextTokens = settings.minContextTokens;
    s.skipReason = this.skipReason(s, settings, child);
    s.nextPingAt = s.skipReason === null ? this.pingTime(s) : null;

    if (s.nextPingAt !== null) {
      const delay = Math.max(0, s.nextPingAt - this.deps.now());
      s.timer = { handle: this.deps.setTimer(() => this.fire(sessionID, generation), delay) };
    }
    this.commit(sessionID, s);
  }

  private skipReason(s: SessionState, settings: Settings, child: boolean): SkipReason | null {
    if (child) return "child";
    if (!settings.keepalive) return "disabled";
    if (!s.cacheSeen || s.ttl === null || s.lastRequestAt === null) return "no-cache-seen";
    if ((s.contextTokens ?? 0) < settings.minContextTokens) return "small-context";
    if (s.missed) return "missed";
    if (s.pingsUsed >= settings.maxPings) return "exhausted";
    return null;
  }

  /** When the next ping is due, or null when it could not land before the cache expires. */
  private pingTime(s: SessionState): number | null {
    if (s.ttl === null || s.lastRequestAt === null) return null;
    const cutoff = s.lastRequestAt + TTL_MS[s.ttl] - EXPIRY_MARGIN_MS;
    const due = s.lastPing === "failed" && s.retryAt !== null ? s.retryAt : s.lastRequestAt + PING_OFFSET_MS[s.ttl];
    if (due > cutoff || this.deps.now() > cutoff) return null;
    return due;
  }

  private fire(sessionID: string, generation: number): void {
    const s = this.sessions.get(sessionID);
    if (this.disposed || !s || s.generation !== generation) return;
    s.timer = null;

    const now = this.deps.now();
    const expiresAt = s.lastRequestAt !== null && s.ttl !== null ? s.lastRequestAt + TTL_MS[s.ttl] : null;
    if (expiresAt === null || now > expiresAt - EXPIRY_MARGIN_MS) {
      s.nextPingAt = null;
      this.commit(sessionID, s);
      return;
    }

    s.pingsUsed++;
    s.nextPingAt = null;
    const inflight: PingInFlight = { firedAt: now, sentAt: null, contextBefore: s.contextTokens };
    s.inflight = inflight;
    this.commit(sessionID, s);

    const settled = () => {
      // Resolved without a response seen, or rejected: unless a response (or a
      // newer real request) already settled this ping, it failed.
      if (s.inflight === inflight && !this.disposed) {
        s.inflight = null;
        void this.failPing(sessionID, s);
      }
    };
    this.deps.ping(sessionID).then(settled, settled);
  }

  private async failPing(sessionID: string, s: SessionState): Promise<void> {
    s.lastPing = "failed";
    s.retryAt = this.deps.now() + RETRY_DELAY_MS;
    this.commit(sessionID, s);
    await this.schedule(sessionID);
  }
}
