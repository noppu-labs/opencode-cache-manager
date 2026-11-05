import { describe, expect, test } from 'bun:test';

import { isProcessAlive } from '../../src/utils/is-process-alive.ts';

describe('isProcessAlive', () => {
  test('this process is alive', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  test('a process owned by someone else still counts as alive', () => {
    // PID 1 exists but signalling it is refused, which is not the same as it having gone.
    expect(isProcessAlive(1)).toBe(true);
  });

  test('a PID nothing is running under is not alive', () => {
    expect(isProcessAlive(2_147_483_646)).toBe(false);
  });

  test.each([0, -1, 1.5])('%d names no single process', (pid) => {
    expect(isProcessAlive(pid)).toBe(false);
  });
});
