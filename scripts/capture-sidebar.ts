/**
 * Renders one sidebar screen for the docs as truecolor ANSI on stdout, or,
 * with --all, regenerates every docs/images/<screen>.svg through Charm's
 * freeze. See docs/CONTRIBUTING.md, "Sidebar images".
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSolidTransformPlugin } from "@opentui/solid/bun-plugin";

// Clock times in the section come from toLocaleTimeString, so pin the zone
// before any Date is formatted.
process.env.TZ = "UTC";

// The Solid transform must be registered before any module with JSX loads, so
// the screens are imported dynamically below.
ensureSolidTransformPlugin();

const ROOT = join(import.meta.dir, "..");
const FREEZE_FLAGS = [
  "--window=false",
  "--background",
  "#0a0a0a",
  "--padding",
  "20",
  "--margin",
  "0",
  "--border.radius",
  "8",
  "--font.family",
  "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  "--font.size",
  "14",
  "--line-height",
  "1.2",
];

const { CAPTURE_NOW, SCREEN_NAMES, SECTION_HEADER, isScreenName, renderScreen }: typeof import("./capture/screens.tsx") =
  await import("./capture/screens.tsx");

/** freeze 0.2 drops SGR bold, and the section header is the only bold text, so it is restored here. */
function withBoldHeader(svg: string): string {
  return svg.replaceAll(`>${SECTION_HEADER}</tspan>`, ` font-weight="bold">${SECTION_HEADER}</tspan>`);
}

function renderSvg(screen: string, dir: string): boolean {
  const svg = join(dir, `${screen}.svg`);
  const freeze = Bun.spawnSync(
    ["freeze", "--execute", `bun scripts/capture-sidebar.ts ${screen}`, "--output", svg, ...FREEZE_FLAGS],
    { cwd: ROOT, stdout: "inherit", stderr: "inherit" },
  );
  if (freeze.exitCode !== 0) {
    console.error(`freeze failed for ${screen}; run \`bun scripts/capture-sidebar.ts ${screen}\` to see the error`);
    return false;
  }
  writeFileSync(svg, withBoldHeader(readFileSync(svg, "utf8")));
  return true;
}

/** Renders every screen into a staging directory, then copies them over docs/images/ only if all succeeded. */
function regenerate(): number {
  if (!Bun.which("freeze")) {
    console.error("freeze is not installed: brew install charmbracelet/tap/freeze");
    return 1;
  }
  const staging = mkdtempSync(join(tmpdir(), "cache-manager-capture-"));
  try {
    for (const screen of SCREEN_NAMES) if (!renderSvg(screen, staging)) return 1;
    const images = join(ROOT, "docs/images");
    mkdirSync(images, { recursive: true });
    for (const screen of SCREEN_NAMES) copyFileSync(join(staging, `${screen}.svg`), join(images, `${screen}.svg`));
    return 0;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function capture(screen: string | undefined): Promise<number> {
  if (screen === undefined || !isScreenName(screen)) {
    console.error(`usage: bun scripts/capture-sidebar.ts <${SCREEN_NAMES.join(" | ")}> | --all`);
    return 2;
  }
  // The component reads Date.now for its countdowns; a fixed clock keeps the rows, and the SVGs, stable.
  Date.now = (): number => CAPTURE_NOW;
  const rows = await renderScreen(screen);
  await Bun.write(Bun.stdout, `${rows.join("\n")}\n`);
  return 0;
}

const [argument] = Bun.argv.slice(2);
// A rendered TUI keeps the event loop alive, and freeze waits for the process to end, so exit explicitly.
process.exit(argument === "--all" ? regenerate() : await capture(argument));
