/**
 * Renders one screen for the docs (a sidebar sample or the picker) as truecolor ANSI on stdout, or,
 * with --all, regenerates every docs/images/<screen>.svg through Charm's
 * freeze. See docs/CONTRIBUTING.md, "Sidebar images".
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureSolidTransformPlugin } from '@opentui/solid/bun-plugin';

import { isNonEmptyString } from '../src/utils/is-non-empty-string.ts';
import { restoreBold } from './capture/ansi.ts';
import type { ScreenName } from './capture/screens.tsx';

/*
 * Clock times in the section come from toLocaleTimeString, so pin the zone
 * before any Date is formatted.
 */
process.env.TZ = 'UTC';

/*
 * The Solid transform must be registered before any module with JSX loads, so
 * the screens are imported dynamically below.
 */
ensureSolidTransformPlugin();

const ROOT = join(import.meta.dir, '..');
const FREEZE_FLAGS = [
  '--window=false',
  '--background',
  '#0a0a0a',
  '--padding',
  '20',
  '--margin',
  '0',
  '--border.radius',
  '8',
  '--font.family',
  'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  '--font.size',
  '14',
  '--line-height',
  '1.2',
];

const { CAPTURE_NOW, SCREEN_NAMES, isScreenName, renderScreen } =
  await import('./capture/screens.tsx');

// The components read Date.now for their countdowns; a fixed clock keeps the rows, and the SVGs, stable.
Date.now = (): number => CAPTURE_NOW;

async function renderSvg(screen: ScreenName, dir: string): Promise<boolean> {
  const svg = join(dir, `${screen}.svg`);
  const freeze = Bun.spawnSync(
    [
      'freeze',
      '--execute',
      `bun scripts/capture-sidebar.ts ${screen}`,
      '--output',
      svg,
      ...FREEZE_FLAGS,
    ],
    { cwd: ROOT, stderr: 'inherit', stdout: 'inherit' }
  );
  if (freeze.exitCode !== 0) {
    // oxlint-disable-next-line eslint/no-console -- CLI script: stderr messages and exit codes are its interface
    console.error(
      `freeze failed for ${screen}; run \`bun scripts/capture-sidebar.ts ${screen}\` to see the error`
    );
    return false;
  }
  writeFileSync(svg, restoreBold(readFileSync(svg, 'utf8'), await renderScreen(screen)));
  return true;
}

/** Renders every screen into a staging directory, then copies them over docs/images/ only if all succeeded. */
async function regenerate(): Promise<number> {
  if (!isNonEmptyString(Bun.which('freeze'))) {
    // oxlint-disable-next-line eslint/no-console -- CLI script: stderr messages and exit codes are its interface
    console.error('freeze is not installed: brew install charmbracelet/tap/freeze');
    return 1;
  }
  const staging = mkdtempSync(join(tmpdir(), 'cache-manager-capture-'));
  try {
    for (const screen of SCREEN_NAMES) if (!(await renderSvg(screen, staging))) return 1;
    const images = join(ROOT, 'docs/images');
    mkdirSync(images, { recursive: true });
    for (const screen of SCREEN_NAMES) {
      copyFileSync(join(staging, `${screen}.svg`), join(images, `${screen}.svg`));
    }
    return 0;
  } finally {
    rmSync(staging, { force: true, recursive: true });
  }
}

async function capture(screen: string | undefined): Promise<number> {
  if (screen === undefined || !isScreenName(screen)) {
    // oxlint-disable-next-line eslint/no-console -- CLI script: stderr messages and exit codes are its interface
    console.error(`usage: bun scripts/capture-sidebar.ts <${SCREEN_NAMES.join(' | ')}> | --all`);
    return 2;
  }
  const rows = await renderScreen(screen);
  await Bun.write(Bun.stdout, `${rows.join('\n')}\n`);
  return 0;
}

const [argument] = Bun.argv.slice(2);
// A rendered TUI keeps the event loop alive, and freeze waits for the process to end, so exit explicitly.
// oxlint-disable-next-line unicorn/no-process-exit -- CLI script: stderr messages and exit codes are its interface
process.exit(argument === '--all' ? await regenerate() : await capture(argument));
