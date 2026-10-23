import { describe, expect, test } from "bun:test";
import type { KeepaliveSnapshot } from "../../src/models/keepalive.ts";
import {
  alignPingMessages,
  alignPingRequest,
  readMessages,
  releasesMessages,
} from "../../src/services/ping-alignment.ts";
import { ephemeral, makeRequest, parsedBodyOf, sampleBody } from "../helpers/fixtures.ts";

const NOW = 1_000_000;

function snapshot(overrides: Partial<KeepaliveSnapshot> = {}): KeepaliveSnapshot {
  return {
    sessionID: "ses_a",
    ttl: "5m",
    ttlSource: "detected",
    lastRequestAt: null,
    expiresAt: null,
    nextPingAt: null,
    pingsUsed: 0,
    maxPings: 5,
    minContextTokens: 0,
    lastPing: null,
    skipReason: null,
    contextTokens: null,
    lastCache: null,
    ...overrides,
  };
}

describe("readMessages", () => {
  test("returns the body and its messages", async () => {
    const body = sampleBody();
    const parsed = await readMessages(makeRequest(JSON.stringify(body)));
    expect(parsed?.body).toEqual(body);
    expect(parsed?.messages).toEqual(body.messages as unknown[]);
  });

  test("returns an empty messages array as-is", async () => {
    const parsed = await readMessages(makeRequest(JSON.stringify({ model: "m", messages: [] })));
    expect(parsed).toEqual({ body: { model: "m", messages: [] }, messages: [] });
  });

  test("is undefined for invalid JSON", async () => {
    expect(await readMessages(makeRequest("{not json"))).toBeUndefined();
  });

  test("is undefined for an empty body", async () => {
    expect(await readMessages(makeRequest(undefined))).toBeUndefined();
  });

  test("is undefined for non-object bodies", async () => {
    for (const body of ["null", "42", '"text"', "true"]) {
      expect(await readMessages(makeRequest(body))).toBeUndefined();
    }
  });

  test("is undefined for an array body", async () => {
    expect(await readMessages(makeRequest(JSON.stringify([{ role: "user" }])))).toBeUndefined();
  });

  test("is undefined when messages is missing", async () => {
    expect(await readMessages(makeRequest(JSON.stringify({ model: "m" })))).toBeUndefined();
  });

  test("is undefined when messages is not an array", async () => {
    for (const messages of [null, "hi", 3, { role: "user" }]) {
      expect(await readMessages(makeRequest(JSON.stringify({ messages })))).toBeUndefined();
    }
  });

  test("does not consume the original request body", async () => {
    const request = makeRequest(JSON.stringify(sampleBody()));
    await readMessages(request);
    expect(request.bodyUsed).toBe(false);
    expect(await parsedBodyOf(request)).toEqual(sampleBody());
  });
});

describe("alignPingRequest", () => {
  const primary = [
    { role: "user", content: [{ type: "text", text: "primary one", cache_control: ephemeral() }] },
    { role: "assistant", content: [{ type: "text", text: "primary two" }] },
  ];

  test("returns the same request when there is no primary", async () => {
    const request = makeRequest(JSON.stringify(sampleBody()));
    expect(await alignPingRequest(request, undefined)).toBe(request);
  });

  test("returns the same request when the body has no messages", async () => {
    const request = makeRequest(JSON.stringify({ model: "m" }));
    expect(await alignPingRequest(request, primary)).toBe(request);
  });

  test("returns the same request when the body is not JSON", async () => {
    const request = makeRequest("{not json");
    expect(await alignPingRequest(request, primary)).toBe(request);
  });

  test("returns a new request with the messages aligned to the primary", async () => {
    const body = sampleBody();
    const request = makeRequest(JSON.stringify(body));
    const aligned = await alignPingRequest(request, primary);
    expect(aligned).not.toBe(request);
    expect((await parsedBodyOf(aligned)).messages).toEqual(
      alignPingMessages(body.messages as unknown[], primary),
    );
  });

  test("keeps the other body fields", async () => {
    const body = sampleBody();
    const aligned = await alignPingRequest(makeRequest(JSON.stringify(body)), primary);
    const { messages: _messages, ...rest } = await parsedBodyOf(aligned);
    const { messages: _original, ...expected } = body;
    expect(rest).toEqual(expected);
  });

  test("keeps the url, method and headers", async () => {
    const request = makeRequest(JSON.stringify(sampleBody()), { "x-custom": "yes" });
    const aligned = await alignPingRequest(request, primary);
    expect(aligned.url).toBe(request.url);
    expect(aligned.method).toBe("POST");
    expect(aligned.headers.get("x-custom")).toBe("yes");
    expect(aligned.headers.get("content-type")).toBe("application/json");
  });

  test("drops content-length", async () => {
    const request = makeRequest(JSON.stringify(sampleBody()), { "content-length": "12345" });
    expect(request.headers.get("content-length")).toBe("12345");
    const aligned = await alignPingRequest(request, primary);
    expect(aligned.headers.has("content-length")).toBe(false);
  });

  test("does not consume or alter the original request", async () => {
    const body = sampleBody();
    const request = makeRequest(JSON.stringify(body));
    await alignPingRequest(request, primary);
    expect(request.bodyUsed).toBe(false);
    expect(await parsedBodyOf(request)).toEqual(body);
  });

  test("propagates the original abort signal", async () => {
    const controller = new AbortController();
    const request = new Request("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify(sampleBody()),
      signal: controller.signal,
    });
    const aligned = await alignPingRequest(request, primary);
    expect(aligned.signal.aborted).toBe(false);
    controller.abort();
    expect(aligned.signal.aborted).toBe(true);
  });
});

describe("releasesMessages", () => {
  test("is true once the cache has expired", () => {
    expect(releasesMessages(snapshot({ expiresAt: NOW - 1 }), NOW)).toBe(true);
  });

  test("is true when the cache expires exactly now", () => {
    expect(releasesMessages(snapshot({ expiresAt: NOW }), NOW)).toBe(true);
  });

  test("is false while the cache is still live", () => {
    expect(releasesMessages(snapshot({ expiresAt: NOW + 1 }), NOW)).toBe(false);
  });

  test("is true for skip reasons that end pinging", () => {
    for (const skipReason of ["child", "implicit", "missed", "exhausted", "disabled"] as const) {
      expect(releasesMessages(snapshot({ skipReason }), NOW)).toBe(true);
    }
  });

  test("is true for an ending skip reason even with a future expiry", () => {
    expect(releasesMessages(snapshot({ expiresAt: NOW + 1000, skipReason: "missed" }), NOW)).toBe(true);
  });

  test("is false for transient skip reasons", () => {
    for (const skipReason of ["busy", "small-context", "no-cache-seen"] as const) {
      expect(releasesMessages(snapshot({ skipReason }), NOW)).toBe(false);
    }
  });

  test("is false for a transient skip reason with a future expiry", () => {
    expect(releasesMessages(snapshot({ expiresAt: NOW + 1000, skipReason: "busy" }), NOW)).toBe(false);
  });

  test("is false with no expiry and no skip reason", () => {
    expect(releasesMessages(snapshot(), NOW)).toBe(false);
  });

  test("is true for an expired cache with a transient skip reason", () => {
    expect(releasesMessages(snapshot({ expiresAt: NOW - 1, skipReason: "busy" }), NOW)).toBe(true);
  });
});

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
