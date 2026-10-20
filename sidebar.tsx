import type { Plugin } from "@opencode/plugin/tui";
import { createEffect, createSignal, For, onCleanup } from "solid-js";
import { sidebarLines, type Tone } from "./display.ts";
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

function CacheSection(props: {
  ctx: Plugin.Context;
  sessionID: string;
  snapshots: () => ReadonlyMap<string, KeepaliveSnapshot>;
  load: (sessionID: string) => void;
}) {
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(timer));

  createEffect(() => props.load(props.sessionID));

  const lines = () => sidebarLines(props.snapshots().get(props.sessionID), now());

  return (
    <box flexDirection="column">
      <For each={lines()}>
        {(line) => <text fg={toneColor(props.ctx.theme, line.tone)}>{line.text}</text>}
      </For>
    </box>
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
    render: ({ sessionID }) => <CacheSection ctx={ctx} sessionID={sessionID} snapshots={snapshots} load={load} />,
  });
}
