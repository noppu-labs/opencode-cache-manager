import solidPlugin from "@opentui/solid/bun-plugin";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
export const SIDEBAR_SOURCE = join(ROOT, "src/ui/sidebar.tsx");
export const SIDEBAR_COMPILED = join(ROOT, "src/ui/sidebar.compiled.js");

/**
 * Compiles the sidebar with OpenTUI's Solid transform. The host skips that
 * transform for files under node_modules, so an npm install must ship this
 * output; package imports stay external so the host binds them to its own
 * Solid and OpenTUI instances.
 */
export async function buildSidebar(outFile: string = SIDEBAR_COMPILED): Promise<void> {
  const result = await Bun.build({
    entrypoints: [SIDEBAR_SOURCE],
    target: "bun",
    format: "esm",
    packages: "external",
    plugins: [solidPlugin],
  });
  if (!result.success || result.outputs.length !== 1) {
    throw new AggregateError(result.logs, `sidebar build failed (${result.outputs.length} outputs)`);
  }
  await Bun.write(outFile, result.outputs[0]!);
}

if (import.meta.main) await buildSidebar();
