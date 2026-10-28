import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildSidebar } from '../scripts/build-sidebar.ts';

const CWD = `${import.meta.dir}/..`;

const manifest = JSON.parse(readFileSync(join(CWD, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
  license: string;
  publishConfig?: { access?: string };
  exports?: Record<string, string>;
  files?: string[];
};

// Pack once into a temp dir. `npm pack` from the repo packs the `files`
// whitelist, so what it emits is what `npm publish` would upload. Nothing
// is published.
let tmpDir: string | undefined;
let tgzPath: string | undefined;

function packOnce(): string {
  if (tgzPath !== undefined) return tgzPath;
  // CI packs the real artifact once in the release workflow and points the
  // suite at it, so the suite verifies the exact tarball that ships.
  const override = process.env.CACHE_MANAGER_TEST_TARBALL;
  if (override !== undefined && override !== '') {
    if (!existsSync(override)) throw new Error(`CACHE_MANAGER_TEST_TARBALL missing: ${override}`);
    tgzPath = override;
    return tgzPath;
  }
  tmpDir = mkdtempSync(join(tmpdir(), 'cache-manager-pkg-'));
  // `npm pack --ignore-scripts` skips `prepack`, so build the compiled
  // sidebar here, the way CI's `npm publish` would have.
  const build = Bun.spawnSync({
    cmd: ['bun', 'run', 'build'],
    cwd: CWD,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(build.exitCode).toBe(0);
  const pack = Bun.spawnSync({
    cmd: ['npm', 'pack', '--ignore-scripts', '--pack-destination', tmpDir],
    cwd: CWD,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(pack.exitCode).toBe(0);
  const tarballs = readdirSync(tmpDir).filter((f) => f.endsWith('.tgz'));
  expect(tarballs).toHaveLength(1);
  tgzPath = join(tmpDir, tarballs[0]);
  return tgzPath;
}

function extract(): string {
  tmpDir ??= mkdtempSync(join(tmpdir(), 'cache-manager-pkg-x-'));
  const tar = Bun.spawnSync({
    cmd: ['tar', '-xzf', packOnce(), '-C', tmpDir],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(tar.exitCode).toBe(0);
  // macOS hands out /var/folders/... but Bun.resolveSync dereferences the
  // symlink to /private/var/folders/..., so compare real paths throughout.
  const dir = realpathSync(join(tmpDir, 'package'));
  expect(existsSync(join(dir, 'package.json'))).toBe(true);
  return dir;
}

/** Every source file under `src/`, relative to the repo root. */
function sourceFiles(): string[] {
  return [...new Bun.Glob('src/**/*.{ts,tsx}').scanSync({ cwd: CWD })].toSorted();
}

const COMPILED_SIDEBAR = 'src/ui/sidebar.compiled.js';

/** The exact ship set: metadata, docs, every source file and the compiled sidebar. Nothing else. */
const SHIP_FILES = [
  'LICENSE',
  'README.md',
  'package.json',
  COMPILED_SIDEBAR,
  ...sourceFiles(),
].toSorted();

afterAll(() => {
  if (tmpDir !== undefined) rmSync(tmpDir, { recursive: true, force: true });
});

describe('npm package manifest', () => {
  test('publishes under the scoped name, MIT, public access', () => {
    expect(manifest.name).toBe('@noppu-labs/opencode-cache-manager');
    // Release-time consistency (tag == vX.Y.Z of package.json) is enforced by
    // the release workflow's gate; here the version only needs to be
    // well-formed.
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/u);
    expect(manifest.license).toBe('MIT');
    expect(manifest.publishConfig?.access).toBe('public');
  });

  test('declares the OpenCode host SDK as a peer dependency', () => {
    const peers = (
      JSON.parse(readFileSync(join(CWD, 'package.json'), 'utf8')) as {
        peerDependencies?: Record<string, string>;
        dependencies?: Record<string, string>;
      }
    ).peerDependencies;
    expect(peers?.['@opencode/plugin']).toBe('>=2.0.22 <3');
  });

  // npm skips optional peers, and the OpenCode installer does not provide
  // these to a plugin's install dir, so the sidebar import fails without them.
  test('requires the packages the sidebar imports at runtime as peers', () => {
    const pkg = JSON.parse(readFileSync(join(CWD, 'package.json'), 'utf8')) as {
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };
    for (const name of ['@opentui/core', '@opentui/solid', 'solid-js']) {
      expect(pkg.peerDependencies?.[name]).toBeDefined();
      expect(pkg.peerDependenciesMeta?.[name]?.optional).not.toBe(true);
    }
  });

  test('files whitelist covers exactly the ship set', () => {
    expect((manifest.files ?? []).toSorted()).toEqual(['LICENSE', 'README.md', 'src']);
  });
});

describe('npm package tarball', () => {
  test('contains exactly the ship set', () => {
    const tar = Bun.spawnSync({
      cmd: ['tar', '-tzf', packOnce()],
      cwd: CWD,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(tar.exitCode).toBe(0);
    const listed = tar.stdout
      .toString()
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.replace(/^package\//u, ''))
      .toSorted();
    expect(listed).toEqual(SHIP_FILES);
  });

  test('extracted manifest matches the repo manifest', () => {
    const shipped = JSON.parse(readFileSync(join(extract(), 'package.json'), 'utf8'));
    expect(shipped.name).toBe(manifest.name);
    expect(shipped.version).toBe(manifest.version);
    expect(shipped.exports).toEqual(manifest.exports);
  });
});

describe('Host.resolve against the extracted package', () => {
  // This replays @opencode/plugin/dist/host.js: entry(["server", ""]) /
  // entry(["tui"]) / entry(["rpc"]) through Bun.resolveSync(specifier,
  // directory) -- the exact resolution the OpenCode runtime performs for a
  // configured npm plugin.
  test('resolves server, tui and rpc entrypoints', () => {
    const dir = extract();
    const name = manifest.name;

    const server = Bun.resolveSync(`${name}/server`, dir);
    expect(server.endsWith('src/server.ts')).toBe(true);
    expect(server.startsWith(dir)).toBe(true);

    const tui = Bun.resolveSync(`${name}/tui`, dir);
    expect(tui.endsWith('src/tui.ts')).toBe(true);

    const rpc = Bun.resolveSync(`${name}/rpc`, dir);
    expect(rpc.endsWith('src/rpc.ts')).toBe(true);

    // The bare-name fallback of entry(["server", ""]) must also resolve.
    const bare = Bun.resolveSync(name, dir);
    expect(bare.endsWith('src/server.ts')).toBe(true);
  });

  // tsconfig.json does not ship, so the extracted tree has no jsxImportSource
  // to inherit; without a per-file pragma Bun falls back to React JSX.
  test('shipped .tsx files compile against the OpenTUI Solid JSX runtime', () => {
    const dir = extract();
    const tsx = sourceFiles().filter((f) => f.endsWith('.tsx'));
    expect(tsx.length).toBeGreaterThan(0);
    for (const file of tsx) {
      const build = Bun.spawnSync({
        cmd: ['bun', 'build', file, '--no-bundle'],
        cwd: dir,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(build.exitCode).toBe(0);
      const out = build.stdout.toString();
      expect(out).toContain('from "@opentui/solid/jsx-dev-runtime"');
      expect(out).not.toContain('react/jsx');
    }
  });

  test('shipped sources are byte-identical to the tested sources', () => {
    // Loadability of these exact files is covered by the main suite (it
    // imports them from the repo). What the tarball must additionally
    // guarantee is that what ships is what was tested -- byte for byte.
    const dir = extract();
    for (const file of sourceFiles()) {
      expect(readFileSync(join(dir, file))).toEqual(readFileSync(join(CWD, file)));
    }
  });

  // The host skips the Solid transform under node_modules, so an npm
  // install renders the sidebar from this file; see scripts/build-sidebar.ts.
  test('ships a Solid-compiled sidebar that imports only the host runtime', () => {
    const dir = extract();
    const code = readFileSync(join(dir, COMPILED_SIDEBAR), 'utf8');
    expect(code).toContain('createComponent');
    expect(code).not.toContain('jsx-dev-runtime');
    const allowed = new Set(['@opentui/solid', 'solid-js', 'solid-js/store']);
    for (const match of code.matchAll(/\bfrom\s*["']([^"']+)["']/gu)) {
      expect(allowed.has(match[1])).toBe(true);
    }
  });

  test('shipped compiled sidebar matches a fresh build of the shipped source', async () => {
    const dir = extract();
    const tmpOut = join(tmpDir!, 'sidebar.compiled.fresh.js');
    await buildSidebar(tmpOut);
    expect(readFileSync(join(dir, COMPILED_SIDEBAR))).toEqual(readFileSync(tmpOut));
  });

  test('tui.ts imports the compiled sidebar by a literal specifier', () => {
    const dir = extract();
    const tui = readFileSync(join(dir, 'src/tui.ts'), 'utf8');
    expect(tui).toContain("import('./ui/sidebar.compiled.js')");
  });
});
