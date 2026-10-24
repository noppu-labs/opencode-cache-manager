import { describe, expect, test } from "bun:test";
import { EXTENDED_CACHE_BETA, SENTINEL_HEADER } from "../../src/constants/anthropic.ts";
import {
  hasCacheControl,
  injectOpenAiBreakpoints,
  rewriteOpenAiCacheTtl,
} from "../../src/services/openai-cache-ttl.ts";
import { transformHttpRequest } from "../../src/services/cache-ttl.ts";
import { ephemeral, transformOpts } from "../helpers/fixtures.ts";

type Rec = Record<string, unknown>;

const URL = "https://openrouter.ai/api/v1/chat/completions";

function tool(name: string, cacheControl?: Rec): Rec {
  return {
    type: "function",
    function: { name, description: name, parameters: { type: "object" } },
    cache_control: cacheControl,
  };
}

function textPart(text: string, cacheControl?: Rec): Rec {
  return cacheControl ? { type: "text", text, cache_control: cacheControl } : { type: "text", text };
}

/** A body shaped like OpenCode's output for an explicit-cache model. */
function markedBody(): Rec {
  return {
    model: "anthropic/claude-haiku-5-5",
    stream: true,
    tools: [tool("read"), tool("write", ephemeral())],
    messages: [
      { role: "system", content: [textPart("sys", ephemeral())] },
      { role: "user", content: [textPart("hi")] },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "result", cache_control: ephemeral() },
      { role: "system", content: [textPart("late system", ephemeral())] },
      { role: "user", content: [textPart("tail", ephemeral())] },
    ],
  };
}

function plainBody(overrides: Rec = {}): Rec {
  return {
    model: "anthropic/claude-haiku-5-5",
    tools: [tool("read"), tool("write")],
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "hello" },
    ],
    ...overrides,
  };
}

/** Breakpoints in wire order: tools, then messages (message-level before its parts). */
function breakpointsInOrder(body: Rec): Rec[] {
  const out: Rec[] = [];
  const push = (node: unknown) => {
    if (node && typeof node === "object") {
      const cc = (node as Rec).cache_control;
      if (cc && typeof cc === "object") out.push(cc as Rec);
    }
  };
  for (const t of (body.tools as unknown[] | undefined) ?? []) push(t);
  for (const m of (body.messages as Rec[] | undefined) ?? []) {
    push(m);
    if (Array.isArray(m.content)) for (const part of m.content) push(part);
  }
  return out;
}

function expectNoOneHourAfterFiveMinute(body: Rec) {
  let seenFiveMinute = false;
  for (const cc of breakpointsInOrder(body)) {
    if (cc.type !== "ephemeral") continue;
    if (cc.ttl === "1h") expect(seenFiveMinute).toBe(false);
    else seenFiveMinute = true;
  }
}

describe("rewriteOpenAiCacheTtl", () => {
  test("1h sets the TTL on tool, part and tool-message breakpoints", () => {
    const body = markedBody();
    expect(rewriteOpenAiCacheTtl(body, "1h")).toBe(true);
    const all = breakpointsInOrder(body);
    expect(all).toHaveLength(5);
    for (const cc of all) expect(cc.ttl).toBe("1h");
  });

  test("5m removes the TTL everywhere", () => {
    const body = markedBody();
    rewriteOpenAiCacheTtl(body, "1h");
    expect(rewriteOpenAiCacheTtl(body, "5m")).toBe(true);
    for (const cc of breakpointsInOrder(body)) expect("ttl" in cc).toBe(false);
  });

  test("5m on a body without TTLs reports no change", () => {
    expect(rewriteOpenAiCacheTtl(markedBody(), "5m")).toBe(false);
  });

  test("hybrid gives 1h to tools and the leading system message only", () => {
    const body = markedBody();
    rewriteOpenAiCacheTtl(body, "hybrid");

    const messages = body.messages as Rec[];
    const tools = body.tools as Rec[];
    expect((tools[1].cache_control as Rec).ttl).toBe("1h");
    expect(((messages[0].content as Rec[])[0].cache_control as Rec).ttl).toBe("1h");
    expect("ttl" in (messages[3].cache_control as Rec)).toBe(false);
    expect("ttl" in ((messages[4].content as Rec[])[0].cache_control as Rec)).toBe(false);
    expect("ttl" in ((messages[5].content as Rec[])[0].cache_control as Rec)).toBe(false);
    expectNoOneHourAfterFiveMinute(body);
  });

  test("hybrid also covers a message-level breakpoint on a leading developer message", () => {
    const body: Rec = {
      messages: [
        { role: "developer", content: "rules", cache_control: ephemeral() },
        { role: "user", content: [textPart("q", ephemeral())] },
      ],
    };
    rewriteOpenAiCacheTtl(body, "hybrid");
    const messages = body.messages as Rec[];
    expect((messages[0].cache_control as Rec).ttl).toBe("1h");
    expect("ttl" in ((messages[1].content as Rec[])[0].cache_control as Rec)).toBe(false);
    expectNoOneHourAfterFiveMinute(body);
  });

  test("hybrid leaves a 5m-only message tail alone and keeps order", () => {
    const body: Rec = {
      tools: [tool("read", ephemeral())],
      messages: [{ role: "user", content: [textPart("q", ephemeral())] }],
    };
    rewriteOpenAiCacheTtl(body, "hybrid");
    expect(breakpointsInOrder(body).map((cc) => cc.ttl)).toEqual(["1h", undefined]);
  });

  test("leaves non-ephemeral cache_control untouched", () => {
    const body: Rec = {
      tools: [tool("read", { type: "persistent" })],
      messages: [{ role: "user", content: [textPart("q", { type: "other", ttl: "9h" })] }],
    };
    const before = JSON.stringify(body);
    rewriteOpenAiCacheTtl(body, "1h");
    expect(JSON.stringify(body)).toBe(before);
    rewriteOpenAiCacheTtl(body, "5m");
    expect(JSON.stringify(body)).toBe(before);
  });

  test("tolerates malformed bodies", () => {
    expect(rewriteOpenAiCacheTtl({}, "1h")).toBe(false);
    expect(rewriteOpenAiCacheTtl({ tools: "x", messages: [null, 3, { content: "s" }] }, "1h")).toBe(false);
  });
});

describe("hasCacheControl", () => {
  test("finds cache_control on tools, messages and parts", () => {
    expect(hasCacheControl(plainBody())).toBe(false);
    expect(hasCacheControl(plainBody({ tools: [tool("a", ephemeral())] }))).toBe(true);
    expect(
      hasCacheControl(plainBody({ messages: [{ role: "tool", content: "x", cache_control: ephemeral() }] })),
    ).toBe(true);
    expect(
      hasCacheControl(plainBody({ messages: [{ role: "user", content: [textPart("x", ephemeral())] }] })),
    ).toBe(true);
  });
});

describe("injectOpenAiBreakpoints", () => {
  test("marks the last tool, the leading system message and the tail (3 breakpoints)", () => {
    const body = plainBody();
    expect(injectOpenAiBreakpoints(body)).toBe(true);

    const tools = body.tools as Rec[];
    const messages = body.messages as Rec[];
    expect(tools[0].cache_control).toBeUndefined();
    expect(tools[1].cache_control).toEqual({ type: "ephemeral" });
    expect(messages[0].content).toEqual([textPart("You are helpful.", { type: "ephemeral" })]);
    expect(messages[1].content).toEqual([textPart("hello", { type: "ephemeral" })]);
    expect(breakpointsInOrder(body)).toHaveLength(3);
  });

  test("2 breakpoints when there are no tools", () => {
    for (const tools of [undefined, []]) {
      const body = plainBody({ tools });
      injectOpenAiBreakpoints(body);
      expect(breakpointsInOrder(body)).toHaveLength(2);
    }
  });

  test("marks the last text part of the last leading system/developer message", () => {
    const body = plainBody({
      messages: [
        { role: "system", content: "first" },
        { role: "developer", content: [textPart("a"), textPart("b")] },
        { role: "user", content: "q" },
        { role: "system", content: "late" },
        { role: "user", content: "tail" },
      ],
    });
    injectOpenAiBreakpoints(body);
    const messages = body.messages as Rec[];
    expect(messages[0].content).toBe("first");
    expect((messages[1].content as Rec[])[0].cache_control).toBeUndefined();
    expect((messages[1].content as Rec[])[1].cache_control).toEqual({ type: "ephemeral" });
    expect(messages[3].content).toBe("late");
    expect(messages[4].content).toEqual([textPart("tail", { type: "ephemeral" })]);
  });

  test("a final role:tool message gets the breakpoint on a text part", () => {
    const body = plainBody({
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "q" },
        { role: "assistant", content: null, tool_calls: [] },
        { role: "tool", tool_call_id: "c1", content: "result" },
      ],
    });
    injectOpenAiBreakpoints(body);
    const messages = body.messages as Rec[];
    expect(messages[3].content).toEqual([textPart("result", { type: "ephemeral" })]);
    expect("cache_control" in messages[3]).toBe(false);
    expect(messages[1].content).toBe("q");
  });

  test("a final role:tool message with array content marks its last text part", () => {
    const body = plainBody({
      messages: [
        { role: "user", content: "q" },
        { role: "tool", tool_call_id: "c1", content: [textPart("a"), textPart("b")] },
      ],
    });
    injectOpenAiBreakpoints(body);
    const content = (body.messages as Rec[])[1].content as Rec[];
    expect(content[0].cache_control).toBeUndefined();
    expect(content[1].cache_control).toEqual({ type: "ephemeral" });
    expect("cache_control" in (body.messages as Rec[])[1]).toBe(false);
  });

  test("a final role:tool message with empty content falls back to the previous message", () => {
    const body = plainBody({
      messages: [
        { role: "user", content: "q" },
        { role: "tool", tool_call_id: "c1", content: "" },
      ],
    });
    injectOpenAiBreakpoints(body);
    const messages = body.messages as Rec[];
    expect(messages[0].content).toEqual([textPart("q", { type: "ephemeral" })]);
    expect(messages[1].content).toBe("");
  });

  test("a final assistant message with null content falls back to the previous message", () => {
    const body = plainBody({
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: [textPart("q1"), textPart("q2")] },
        { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function" }] },
      ],
    });
    injectOpenAiBreakpoints(body);
    const messages = body.messages as Rec[];
    expect((messages[1].content as Rec[])[1].cache_control).toEqual({ type: "ephemeral" });
    expect((messages[1].content as Rec[])[0].cache_control).toBeUndefined();
    expect(messages[2].cache_control).toBeUndefined();
    expect(messages[2].content).toBeNull();
  });

  test("a final assistant message with text content is marked in place", () => {
    const body = plainBody({
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: "answer" },
      ],
    });
    injectOpenAiBreakpoints(body);
    const messages = body.messages as Rec[];
    expect(messages[1].content).toEqual([textPart("answer", { type: "ephemeral" })]);
  });

  test("a body with only a system message gets no duplicate breakpoint", () => {
    const body = plainBody({ tools: undefined, messages: [{ role: "system", content: "s" }] });
    injectOpenAiBreakpoints(body);
    expect(breakpointsInOrder(body)).toHaveLength(1);
  });

  test("does nothing when any cache_control exists", () => {
    const body = plainBody({ tools: [tool("a"), tool("b", ephemeral())] });
    const before = JSON.stringify(body);
    expect(injectOpenAiBreakpoints(body)).toBe(false);
    expect(JSON.stringify(body)).toBe(before);

    const withPart = plainBody({
      messages: [{ role: "user", content: [textPart("q", { type: "persistent" })] }],
    });
    const beforePart = JSON.stringify(withPart);
    expect(injectOpenAiBreakpoints(withPart)).toBe(false);
    expect(JSON.stringify(withPart)).toBe(beforePart);
  });

  test("adds exactly 3 breakpoints on a large body", () => {
    const body = plainBody({
      tools: Array.from({ length: 12 }, (_, i) => tool(`t${i}`)),
      messages: [
        { role: "system", content: "s1" },
        { role: "developer", content: "s2" },
        ...Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `m${i}` })),
      ],
    });
    injectOpenAiBreakpoints(body);
    expect(breakpointsInOrder(body)).toHaveLength(3);
  });

  test("injected breakpoints keep 1h ahead of 5m after a hybrid rewrite", () => {
    const body = plainBody();
    injectOpenAiBreakpoints(body);
    rewriteOpenAiCacheTtl(body, "hybrid");
    expect(breakpointsInOrder(body).map((cc) => cc.ttl)).toEqual(["1h", "1h", undefined]);
    expectNoOneHourAfterFiveMinute(body);
  });

  test("tolerates malformed bodies", () => {
    expect(injectOpenAiBreakpoints({})).toBe(false);
    expect(injectOpenAiBreakpoints({ messages: [null, 1, { role: "user" }] })).toBe(false);
  });
});

describe("transformHttpRequest on the openai-chat wire", () => {
  function chatRequest(body: Rec, headers: Record<string, string> = {}) {
    return new Request(URL, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  async function bodyOf(request: Request): Promise<Rec> {
    return (await request.json()) as Rec;
  }

  test("hybrid rewrites TTLs and adds the extended-cache beta header", async () => {
    const out = await transformHttpRequest(chatRequest(markedBody()), "hybrid", transformOpts({ wire: "openai-chat" }));
    expect(out.headers.get("anthropic-beta")).toBe(EXTENDED_CACHE_BETA);
    const body = await bodyOf(out);
    expect((body.tools as Rec[])[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expectNoOneHourAfterFiveMinute(body);
  });

  test("merges the beta flag into an existing header", async () => {
    const out = await transformHttpRequest(
      chatRequest(markedBody(), { "anthropic-beta": "interleaved-thinking-2025-05-14" }),
      "1h",
      transformOpts({ wire: "openai-chat" }),
    );
    expect(out.headers.get("anthropic-beta")).toBe(`interleaved-thinking-2025-05-14,${EXTENDED_CACHE_BETA}`);
  });

  test("5m adds no beta header and removes TTLs", async () => {
    const withTtl = markedBody();
    rewriteOpenAiCacheTtl(withTtl, "1h");
    const out = await transformHttpRequest(chatRequest(withTtl), "5m", transformOpts({ wire: "openai-chat" }));
    expect(out.headers.get("anthropic-beta")).toBeNull();
    for (const cc of breakpointsInOrder(await bodyOf(out))) expect("ttl" in cc).toBe(false);
  });

  test("a hybrid request whose only breakpoint is the 5m tail gets no beta header", async () => {
    const body: Rec = { messages: [{ role: "user", content: [textPart("q", ephemeral())] }] };
    const out = await transformHttpRequest(chatRequest(body), "hybrid", transformOpts({ wire: "openai-chat" }));
    expect(out.headers.get("anthropic-beta")).toBeNull();
  });

  test("the sentinel overrides the fallback mode and is stripped", async () => {
    const out = await transformHttpRequest(chatRequest(markedBody(), { [SENTINEL_HEADER]: "1h" }), "5m", transformOpts({
      wire: "openai-chat",
    }));
    expect(out.headers.has(SENTINEL_HEADER)).toBe(false);
    expect(out.headers.get("anthropic-beta")).toBe(EXTENDED_CACHE_BETA);
    for (const cc of breakpointsInOrder(await bodyOf(out))) expect(cc.ttl).toBe("1h");
  });

  test("inject: true adds breakpoints to an unmarked body, then applies the TTL", async () => {
    const out = await transformHttpRequest(chatRequest(plainBody()), "hybrid", transformOpts({
      wire: "openai-chat",
      inject: true,
    }));
    const body = await bodyOf(out);
    expect(breakpointsInOrder(body).map((cc) => cc.ttl)).toEqual(["1h", "1h", undefined]);
    expect(out.headers.get("anthropic-beta")).toBe(EXTENDED_CACHE_BETA);
  });

  test("inject is skipped when the option is absent or false", async () => {
    for (const opts of [transformOpts({ wire: "openai-chat" }), transformOpts({ wire: "openai-chat", inject: false })]) {
      const out = await transformHttpRequest(chatRequest(plainBody()), "1h", opts);
      expect(hasCacheControl(await bodyOf(out))).toBe(false);
      expect(out.headers.get("anthropic-beta")).toBeNull();
    }
  });

  test("inject does not add to a body that already has breakpoints", async () => {
    const out = await transformHttpRequest(chatRequest(markedBody()), "5m", transformOpts({ wire: "openai-chat", inject: true }));
    expect(breakpointsInOrder(await bodyOf(out))).toHaveLength(5);
  });

  test("the sentinel is stripped even when the body is not JSON", async () => {
    const request = new Request(URL, { method: "POST", headers: { [SENTINEL_HEADER]: "1h" }, body: "not json" });
    const out = await transformHttpRequest(request, "5m", transformOpts({ wire: "openai-chat", inject: true }));
    expect(out.headers.has(SENTINEL_HEADER)).toBe(false);
    expect(await out.text()).toBe("not json");
  });

  test("a request that needs no change is returned as is", async () => {
    const request = chatRequest(plainBody());
    expect(await transformHttpRequest(request, "1h", transformOpts({ wire: "openai-chat" }))).toBe(request);
  });
});
