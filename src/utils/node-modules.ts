import { fileURLToPath } from "node:url";

/** Whether a module URL (e.g. `import.meta.url`) has a `node_modules` directory in its path. */
export function isInsideNodeModules(moduleUrl: string): boolean {
  if (!moduleUrl.startsWith("file:")) return false;
  return fileURLToPath(moduleUrl).split(/[\\/]/).includes("node_modules");
}
