import { afterEach, beforeEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { configureDebugLog } from '../../src/utils/debug-log.ts';

/** One line of the trace: the fields every event has, then that event's own. */
interface TraceEvent {
  ev: string;
  pid: number;
  t: string;
  [field: string]: unknown;
}

interface DebugTrace {
  /** The current test's trace file. */
  path: string;
  /** The file's raw text, for checking what never reaches it. */
  text: () => string;
  events: () => TraceEvent[];
}

/** Call inside a `describe`: each test logs metadata to a file of its own, in a temp folder. */
function useDebugTrace(): DebugTrace {
  let dir = '';
  const trace: DebugTrace = {
    events: () =>
      trace
        .text()
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line) as TraceEvent),
    path: '',
    text: () => readFileSync(trace.path, 'utf8'),
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cache-manager-debug-trace-'));
    trace.path = join(dir, 'trace.jsonl');
    configureDebugLog({ bodies: false, path: trace.path });
  });

  afterEach(() => {
    configureDebugLog(undefined);
    rmSync(dir, { force: true, recursive: true });
  });

  return trace;
}

export type { DebugTrace, TraceEvent };
export { useDebugTrace };
