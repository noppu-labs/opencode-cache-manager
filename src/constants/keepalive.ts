import type { Ttl } from "../models/cache.ts";

export const TTL_MS: Record<Ttl, number> = { "5m": 300_000, "1h": 3_600_000, "30m": 1_800_000, "12h": 43_200_000 };
export const PING_OFFSET_MS: Record<Ttl, number> = { "5m": 240_000, "1h": 3_000_000, "30m": 1_500_000, "12h": 36_000_000 };
/** TTLs a response's usage can report (Anthropic write breakdown); the others are only ever requested. */
export const DETECTABLE_TTLS: ReadonlySet<Ttl> = new Set(["5m", "1h"]);
export const HIT_RATIO = 0.9;
export const RETRY_DELAY_MS = 30_000;
/** A ping is never sent later than `expiresAt - EXPIRY_MARGIN_MS`. */
export const EXPIRY_MARGIN_MS = 15_000;
/** How often the sidebar refetches the shown session's snapshot. */
export const SIDEBAR_REFRESH_MS = 5_000;
export const PING_PROMPT = "Do not perform any work and do not use tools. Reply with exactly: OK";
