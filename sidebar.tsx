import type { Plugin } from "@opencode/plugin/tui";
import { createEffect, createSignal, Index, onCleanup, Show } from "solid-js";
import { LABEL_WIDTH, sidebarLines, type Tone } from "./display.ts";
import type { KeepaliveSnapshot } from "./keepalive.ts";

function toneColor(theme: Plugin.Context["theme"], tone: Tone) {
  switch (tone) {
    case "muted":
      return theme.text.muted;
    case "success":
      return theme.text.feedback.success.base;
    case "warning":
      return theme.text.feedback.warning.base;
    case "error":
      return theme.text.feedback.error.base;
    default:
      return theme.text.base;
  }
}

function Lines(props: { ctx: Plugin.Context; snapshot: () => KeepaliveSnapshot | undefined }) {
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(timer));

  const lines = () => sidebarLines(props.snapshot(), now());

  const theme = () => props.ctx.theme;

  return (
    <box flexDirection="column">
      <Index each={lines()}>
        {(line) => (
          <Show
            when={line().right !== undefined}
            fallback={
              <text fg={toneColor(theme(), line().tone)}>
                <Show when={line().bold} fallback={line().text}>
                  <b>{line().text}</b>
                </Show>
              </text>
            }
          >
            <box flexDirection="row">
              <text width={LABEL_WIDTH}>
                <span style={{ fg: toneColor(theme(), line().bullet ?? "base") }}>{line().bullet ? "• " : "  "}</span>
                <span style={{ fg: toneColor(theme(), line().tone) }}>{line().text}</span>
              </text>
              <text fg={toneColor(theme(), line().rightTone ?? "muted")}>{line().right}</text>
            </box>
          </Show>
        )}
      </Index>
    </box>
  );
}

function CacheSection(props: {
  ctx: Plugin.Context;
  sessionID: string;
  snapshots: () => ReadonlyMap<string, KeepaliveSnapshot>;
  load: (sessionID: string) => void;
}) {
  createEffect(() => props.load(props.sessionID));

  const snapshot = () => props.snapshots().get(props.sessionID);
  // Child sessions are never pinged; before a snapshot exists only the TUI's session data can tell.
  const child = () => Boolean(props.ctx.data.session.get(props.sessionID)?.parentID);
  // Whether there is anything to show never depends on the clock, so the ticking child only exists while visible.
  const visible = () => !child() && sidebarLines(snapshot(), 0).length > 0;

  return (
    <Show when={visible()}>
      <Lines ctx={props.ctx} snapshot={snapshot} />
    </Show>
  );
}

/** Claims the `sidebar.content` slot with the cache section; returns the disposer. */
export function registerSidebar(
  ctx: Plugin.Context,
  snapshots: () => ReadonlyMap<string, KeepaliveSnapshot>,
  load: (sessionID: string) => void,
): () => void {
  return ctx.ui.slot({
    append: "sidebar.content",
    // `input` is reactive: read `sessionID` through it so the section follows session switches.
    render: (input) => <CacheSection ctx={ctx} sessionID={input.sessionID} snapshots={snapshots} load={load} />,
  });
}
