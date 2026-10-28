import { join } from 'node:path';

import solidPlugin from '@opentui/solid/bun-plugin';

const ROOT = join(import.meta.dir, '..');
const SIDEBAR_SOURCE = join(ROOT, 'src/ui/sidebar.tsx');
const SIDEBAR_COMPILED = join(ROOT, 'src/ui/sidebar.compiled.js');

/**
 * Compiles the sidebar with OpenTUI's Solid transform. The host skips that
 * transform for files under node_modules, so an npm install must ship this
 * output; package imports stay external so the host binds them to its own
 * Solid and OpenTUI instances.
 */
async function buildSidebar(outFile: string = SIDEBAR_COMPILED): Promise<void> {
  const result = await Bun.build({
    entrypoints: [SIDEBAR_SOURCE],
    format: 'esm',
    packages: 'external',
    plugins: [solidPlugin],
    target: 'bun',
  });
  if (!result.success || result.outputs.length !== 1) {
    throw new AggregateError(
      result.logs,
      `sidebar build failed (${result.outputs.length} outputs)`
    );
  }
  await Bun.write(outFile, result.outputs[0]);
}

if (import.meta.main) await buildSidebar();

export { SIDEBAR_SOURCE, SIDEBAR_COMPILED, buildSidebar };
