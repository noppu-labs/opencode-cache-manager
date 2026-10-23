import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { RGBA, TextAttributes, type CapturedFrame } from "@opentui/core";
import { ensureSolidTransformPlugin } from "@opentui/solid/bun-plugin";
import { frameToAnsi, stripAnsi, textRow } from "../../scripts/capture/ansi.ts";

// The screens render sidebar.tsx, so the Solid transform must be registered before they load.
ensureSolidTransformPlugin();
const screens: typeof import("../../scripts/capture/screens.tsx") = await import("../../scripts/capture/screens.tsx");

const span = (text: string, fg = "#eeeeee", attributes = 0, bg = RGBA.fromValues(0, 0, 0, 0)) => ({
  text,
  fg: RGBA.fromHex(fg),
  bg,
  attributes,
  width: text.length,
});
const line = (...spans: ReturnType<typeof span>[]) => ({ spans });
const frame = (lines: ReturnType<typeof line>[]): CapturedFrame => ({ cols: 20, rows: lines.length, cursor: [0, 0], lines });

describe("frameToAnsi", () => {
  test("drops the unpainted rows around the component and keeps the painted ones", () => {
    const rows = frameToAnsi(frame([line(span("   ")), line(span("Cache")), line(span("  ")), line(span("ttl")), line(span(" "))]));
    expect(rows.map(stripAnsi)).toEqual(["Cache", "", "ttl"]);
  });

  test("emits bold before the colour so the run keeps its colour", () => {
    const [row] = frameToAnsi(frame([line(span("Cache", "#eeeeee", TextAttributes.BOLD))]));
    expect(row).toBe("\u001b[0m\u001b[1m\u001b[38;2;238;238;238mCache\u001b[0m");
  });

  test("a row with only a background is painted", () => {
    const rows = frameToAnsi(frame([line(span("  ", "#eeeeee", 0, RGBA.fromHex("#101010")))]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("\u001b[48;2;16;16;16m");
  });

  test("returns nothing for an empty frame", () => {
    expect(frameToAnsi(frame([line(span(" "))]))).toEqual([]);
  });
});

test("textRow colours each part and resets at the end", () => {
  expect(textRow([{ text: "# ", fg: "#606060" }, { text: "cap", fg: "#ffffff" }])).toBe(
    "\u001b[38;2;96;96;96m# \u001b[38;2;255;255;255mcap\u001b[0m",
  );
});

describe("renderScreen", () => {
  const realNow = Date.now;
  const realTz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = "UTC";
    Date.now = () => screens.CAPTURE_NOW;
  });
  afterAll(() => {
    Date.now = realNow;
    if (realTz === undefined) delete process.env.TZ;
    else process.env.TZ = realTz;
  });

  test("the hero shows a warm 1h cache with a ping scheduled", async () => {
    const rows = (await screens.renderScreen("sidebar")).map(stripAnsi);
    expect(rows).toEqual([
      "Cache",
      "• status      warm",
      "  expires     14:52 (52m)",
      "  ttl         1h (detected)",
      "  next ping   14:42 (42m)",
      "  pings       2/5 ✓ hit",
    ]);
  });

  test("the states screen captions every other state once", async () => {
    const rows = (await screens.renderScreen("sidebar-states")).map(stripAnsi);
    const captions = rows.filter((row) => row.startsWith("# "));
    expect(captions).toHaveLength(screens.SCREENS["sidebar-states"].length);
    expect(new Set(captions).size).toBe(captions.length);
    for (const expected of [
      "waiting for first response",
      "  ttl         5m (requested)",
      "  pings       3/5 ✗ failed",
      "  next ping   none",
      "  keepalive   stopped · last ping missed",
      "  keepalive   waiting · session busy",
      "  keepalive   off · 31k < 50k",
      "  keepalive   off · disabled",
      "  cached      88% · 14k / 16k",
      "  keepalive   n/a · provider-managed",
      "• status      expired",
      "  expired     12m ago",
    ]) {
      expect(rows).toContain(expected);
    }
  });

  test("the header is the only bold text, so the SVG post-processing can find it", async () => {
    const rows = await screens.renderScreen("sidebar");
    const bold = rows.filter((row) => row.includes("\u001b[1m"));
    expect(bold).toHaveLength(1);
    expect(stripAnsi(bold[0]!)).toBe(screens.SECTION_HEADER);
  });
});
