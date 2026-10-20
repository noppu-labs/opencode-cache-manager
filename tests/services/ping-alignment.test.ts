import { describe, expect, test } from "bun:test";
import { alignPingMessages } from "../../src/services/ping-alignment.ts";
import { ephemeral } from "../helpers/fixtures.ts";

describe("alignPingMessages", () => {
  test("replaces the ping history with the primary prefix and keeps the ping tail", () => {
    const ping = [{ id: "p0" }, { id: "p1" }, { id: "ping" }];
    const primary = [{ id: "a0" }, { id: "a1" }, { id: "a2" }];
    expect(alignPingMessages(ping, primary)).toEqual([{ id: "a0" }, { id: "a1" }, { id: "ping" }]);
  });

  test("a shorter primary leaves the extra ping entries untouched", () => {
    const ping = [{ id: "p0" }, { id: "p1" }, { id: "p2" }, { id: "ping" }];
    const primary = [{ id: "a0" }];
    expect(alignPingMessages(ping, primary)).toEqual([{ id: "a0" }, { id: "p1" }, { id: "p2" }, { id: "ping" }]);
  });

  test("an empty primary returns the ping unchanged", () => {
    const ping = [{ id: "p0" }, { id: "ping" }];
    expect(alignPingMessages(ping, [])).toEqual(ping);
  });

  test("returns a new array and does not mutate its inputs", () => {
    const ping = [{ id: "p0" }, { id: "ping" }];
    const primary = [{ id: "a0" }];
    const out = alignPingMessages(ping, primary);
    expect(out).not.toBe(ping);
    expect(ping).toEqual([{ id: "p0" }, { id: "ping" }]);
    expect(primary).toEqual([{ id: "a0" }]);
  });

  test("messages copied from the primary keep their cache_control byte-identical", () => {
    const primary = [
      { role: "user", content: [{ type: "text", text: "a", cache_control: { type: "ephemeral", ttl: "1h" } }] },
      { role: "assistant", cache_control: { type: "ephemeral" }, content: "b" },
    ];
    const ping = [{ role: "user", content: "x" }, { role: "assistant", content: "y" }, { role: "user", content: "ping" }];
    const out = alignPingMessages(ping, primary);
    expect(JSON.stringify(out.slice(0, 2))).toBe(JSON.stringify(primary));
    expect(out[0]).toBe(primary[0]);
  });

  test("the tail and extra entries carry no cache_control at message or part level", () => {
    const marked = (text: string) => ({
      role: "user",
      cache_control: { type: "ephemeral" },
      content: [
        { type: "text", text, cache_control: { type: "ephemeral", ttl: "1h" } },
        { type: "text", text: "plain" },
      ],
    });
    const primary = [marked("a0")];
    const ping = [marked("p0"), marked("p1"), marked("p2"), marked("ping")];
    const out = alignPingMessages(ping, primary) as any[];

    expect(out[0]).toBe(primary[0]);
    for (const message of out.slice(1)) {
      expect("cache_control" in message).toBe(false);
      for (const part of message.content) expect("cache_control" in part).toBe(false);
    }
    expect(out.map((m) => m.content[0].text)).toEqual(["a0", "p1", "p2", "ping"]);
    expect(out[3].content[1]).toEqual({ type: "text", text: "plain" });
    // inputs untouched
    expect(ping[3].cache_control).toEqual({ type: "ephemeral" });
    expect(ping[3].content[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("an empty primary still strips cache_control from the ping", () => {
    const out = alignPingMessages([{ role: "user", content: "x", cache_control: { type: "ephemeral" } }], []);
    expect(out).toEqual([{ role: "user", content: "x" }]);
  });

  test("an empty ping stays empty", () => {
    expect(alignPingMessages([], [{ id: "a0" }])).toEqual([]);
  });
});
