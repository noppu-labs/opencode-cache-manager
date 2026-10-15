import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CWD = `${import.meta.dir}/..`;

const manifest = JSON.parse(readFileSync(join(CWD, "package.json"), "utf8")) as {
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
  if (override) {
    if (!existsSync(override)) throw new Error(`CACHE_MANAGER_TEST_TARBALL missing: ${override}`);
    tgzPath = override;
    return tgzPath;
  }
  tmpDir = mkdtempSync(join(tmpdir(), "cache-manager-pkg-"));
  const pack = Bun.spawnSync({
    cmd: ["npm", "pack", "--ignore-scripts", "--pack-destination", tmpDir],
    cwd: CWD,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(pack.exitCode).toBe(0);
  const tarballs = readdirSync(tmpDir).filter((f) => f.endsWith(".tgz"));
  expect(tarballs).toHaveLength(1);
  tgzPath = join(tmpDir, tarballs[0]!);
  return tgzPath;
}

function extract(): string {
  if (!tmpDir) tmpDir = mkdtempSync(join(tmpdir(), "cache-manager-pkg-x-"));
  const tar = Bun.spawnSync({
    cmd: ["tar", "-xzf", packOnce(), "-C", tmpDir],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(tar.exitCode).toBe(0);
  // macOS hands out /var/folders/... but Bun.resolveSync dereferences the
  // symlink to /private/var/folders/..., so compare real paths throughout.
  const dir = realpathSync(join(tmpDir!, "package"));
  expect(existsSync(join(dir, "package.json"))).toBe(true);
  return dir;
}

/** The exact ship set: entrypoints, metadata, docs. Nothing else. */
const SHIP_FILES = [
  "LICENSE",
  "README.md",
  "package.json",
  "rpc.ts",
  "server.ts",
  "shared.ts",
  "tui.ts",
];

afterAll(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("npm package manifest", () => {
  test("publishes under the scoped name at 0.1.0, MIT, public access", () => {
    expect(manifest.name).toBe("@noppu-labs/opencode-cache-manager");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.license).toBe("MIT");
    expect(manifest.publishConfig?.access).toBe("public");
  });

  test("declares the OpenCode host SDK as a peer dependency", () => {
    const peers = (JSON.parse(readFileSync(join(CWD, "package.json"), "utf8")) as {
      peerDependencies?: Record<string, string>;
      dependencies?: Record<string, string>;
    }).peerDependencies;
    expect(peers?.["@opencode/plugin"]).toBe(">=2.0.22 <3");
  });

  test("files whitelist covers exactly the ship set", () => {
    expect([...(manifest.files ?? [])].sort()).toEqual([
      "LICENSE",
      "README.md",
      "rpc.ts",
      "server.ts",
      "shared.ts",
      "tui.ts",
    ]);
  });
});

describe("npm package tarball", () => {
  test("contains exactly the ship set", () => {
    const tar = Bun.spawnSync({
      cmd: ["tar", "-tzf", packOnce()],
      cwd: CWD,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(tar.exitCode).toBe(0);
    const listed = tar.stdout
      .toString()
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.replace(/^package\//, ""))
      .sort();
    expect(listed).toEqual(SHIP_FILES);
  });

  test("extracted manifest matches the repo manifest", () => {
    const shipped = JSON.parse(readFileSync(join(extract(), "package.json"), "utf8"));
    expect(shipped.name).toBe(manifest.name);
    expect(shipped.version).toBe(manifest.version);
    expect(shipped.exports).toEqual(manifest.exports);
  });
});

describe("Host.resolve against the extracted package", () => {
  // This replays @opencode/plugin/dist/host.js: entry(["server", ""]) /
  // entry(["tui"]) / entry(["rpc"]) through Bun.resolveSync(specifier,
  // directory) -- the exact resolution the OpenCode runtime performs for a
  // configured npm plugin.
  test("resolves server, tui and rpc entrypoints", () => {
    const dir = extract();
    const name = manifest.name;

    const server = Bun.resolveSync(`${name}/server`, dir);
    expect(server.endsWith("server.ts")).toBe(true);
    expect(server.startsWith(dir)).toBe(true);

    const tui = Bun.resolveSync(`${name}/tui`, dir);
    expect(tui.endsWith("tui.ts")).toBe(true);

    const rpc = Bun.resolveSync(`${name}/rpc`, dir);
    expect(rpc.endsWith("rpc.ts")).toBe(true);

    // The bare-name fallback of entry(["server", ""]) must also resolve.
    const bare = Bun.resolveSync(name, dir);
    expect(bare.endsWith("server.ts")).toBe(true);
  });

  test("shipped entrypoints are byte-identical to the tested sources", () => {
    // Loadability of these exact files is covered by the main suite (it
    // imports them from the repo). What the tarball must additionally
    // guarantee is that what ships is what was tested -- byte for byte.
    const dir = extract();
    for (const file of ["server.ts", "tui.ts", "shared.ts", "rpc.ts"]) {
      expect(readFileSync(join(dir, file))).toEqual(readFileSync(join(CWD, file)));
    }
  });
});