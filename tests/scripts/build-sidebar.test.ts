import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildSidebar } from '../../scripts/build-sidebar.ts';

const dir = mkdtempSync(join(tmpdir(), 'cache-manager-sidebar-'));
const outFile = join(dir, 'sidebar.compiled.js');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Every module specifier the file imports, static or dynamic. */
function importSpecifiers(code: string): string[] {
  const found = new Set<string>();
  for (const re of [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s+["']([^"']+)["']/g,
  ]) {
    for (const match of code.matchAll(re)) found.add(match[1]!);
  }
  return [...found].sort();
}

describe('buildSidebar', () => {
  test("compiles the sidebar with Solid's universal transform", async () => {
    await buildSidebar(outFile);
    const code = readFileSync(outFile, 'utf8');
    expect(code).toContain('createComponent');
    expect(code).toContain('insert');
    expect(code).not.toContain('jsx-dev-runtime');
    expect(code).not.toContain('jsx-runtime');
    expect(code).not.toContain('react');
  });

  test('keeps only the host runtime packages as imports', async () => {
    await buildSidebar(outFile);
    const allowed = new Set(['@opentui/solid', 'solid-js', 'solid-js/store']);
    const specifiers = importSpecifiers(readFileSync(outFile, 'utf8'));
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) expect(allowed.has(specifier)).toBe(true);
  });

  test("inlines the plugin's own modules", async () => {
    await buildSidebar(outFile);
    const code = readFileSync(outFile, 'utf8');
    expect(code).toContain('waiting for first response');
    expect(code).toContain('registerSidebar');
  });
});
