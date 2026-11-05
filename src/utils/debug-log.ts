import { appendFileSync } from 'node:fs';

import type { DebugOptions } from '../config/settings.ts';
import { DEBUG_BODY_CHARS, DEBUG_FILE_MODE, DEBUG_LABEL_CHARS } from '../constants/debug.ts';

/** Shared by every plugin instance in the process: the latest `setup` decides. */
let active: DebugOptions | undefined;

function configureDebugLog(options: DebugOptions | undefined): void {
  active = options;
}

function dbgEnabled(): boolean {
  return active !== undefined;
}

/** Appends one JSON line. Never throws: tracing must not change what the plugin does. */
function dbg(event: string, fields: Record<string, unknown> = {}): void {
  if (active === undefined) return;
  try {
    const required = { ev: event, pid: process.pid, t: new Date().toISOString() };
    // The first spread fixes the key order, the last makes the required values win.
    const line = JSON.stringify({ ...required, ...fields, ...required });
    appendFileSync(active.path, `${line}\n`, { mode: DEBUG_FILE_MODE });
  } catch {
    // A trace with a gap is better than a failed request.
  }
}

/** The capped start or end of `text` when `bodies` is on, else `undefined`. */
function dbgExcerpt(text: string, end: 'head' | 'tail'): string | undefined {
  if (active?.bodies !== true) return undefined;
  return end === 'head' ? text.slice(0, DEBUG_BODY_CHARS) : text.slice(-DEBUG_BODY_CHARS);
}

/** Caps a string a response chose, which the trace prints with `bodies` off too. */
function dbgLabel(text: string): string {
  try {
    return text.slice(0, DEBUG_LABEL_CHARS);
  } catch {
    // `finish_reason: "constructor"` reaches here as a function, through the parser's map lookup. Callers sit outside `dbg`'s try.
    return 'unknown';
  }
}

/** An error message can quote a body or a URL, so it needs `bodies`; otherwise only the name. */
function dbgError(error: unknown): string {
  try {
    if (active?.bodies === true) return String(error).slice(0, DEBUG_BODY_CHARS);
    return error instanceof Error ? dbgLabel(error.name) : 'unknown';
  } catch {
    // `String` throws on a value with no string form. Callers sit outside `dbg`'s try.
    return 'unknown';
  }
}

/** Origin and path only: a query string or the userinfo can carry a key. */
function dbgUrl(url: string): string {
  try {
    const { origin, pathname } = new URL(url);
    return `${origin}${pathname}`;
  } catch {
    return '<invalid url>';
  }
}

export { configureDebugLog, dbg, dbgEnabled, dbgError, dbgExcerpt, dbgLabel, dbgUrl };
