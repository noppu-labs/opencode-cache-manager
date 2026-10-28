import { describe, expect, test } from 'bun:test';

import { isInsideNodeModules } from '../../src/utils/node-modules.ts';

describe('isInsideNodeModules', () => {
  test('true for a module inside an npm install', () => {
    expect(
      isInsideNodeModules(
        'file:///Users/me/.cache/opencode/npm/@noppu-labs/opencode-cache-manager@%5E0.2.2/123/node_modules/@noppu-labs/opencode-cache-manager/src/tui.ts'
      )
    ).toBe(true);
  });

  test('false for a local checkout', () => {
    expect(isInsideNodeModules('file:///Users/me/projects/opencode-cache-manager/src/tui.ts')).toBe(
      false
    );
  });

  test('matches whole path segments only', () => {
    expect(isInsideNodeModules('file:///Users/me/my_node_modules_backup/src/tui.ts')).toBe(false);
    expect(isInsideNodeModules('file:///Users/me/node_modules.old/src/tui.ts')).toBe(false);
  });

  test('false for a non-file URL', () => {
    expect(isInsideNodeModules('https://example.com/node_modules/x/tui.ts')).toBe(false);
  });
});
