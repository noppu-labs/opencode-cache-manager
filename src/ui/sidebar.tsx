/** @jsxImportSource @opentui/solid */
import type { Plugin } from '@opencode/plugin/tui';
import type { RGBA } from '@opentui/core';
import { createEffect, createSignal, Index, type JSX, onCleanup, Show } from 'solid-js';

import { SIDEBAR_REFRESH_MS } from '../constants/keepalive.ts';
import { MS_PER_SECOND } from '../constants/units.ts';
import type { KeepaliveSnapshot } from '../models/keepalive.ts';
import { LABEL_WIDTH, type SidebarLine, sidebarLines, type Tone } from './sidebar-lines.ts';

/** The colour of each tone; the TUI takes these from the host theme, the docs capture from a fixed palette. */
type SidebarPalette = Readonly<Record<Tone, RGBA>>;

function paletteFromTheme(theme: Plugin.Context['theme']): SidebarPalette {
  return {
    base: theme.text.base,
    error: theme.text.feedback.error.base,
    muted: theme.text.muted,
    success: theme.text.feedback.success.base,
    warning: theme.text.feedback.warning.base,
  };
}

function CacheLines(props: {
  palette: () => SidebarPalette;
  snapshot: () => KeepaliveSnapshot | undefined;
}): JSX.Element {
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => {
    setNow(Date.now());
  }, MS_PER_SECOND);
  onCleanup(() => {
    clearInterval(timer);
  });

  const lines = (): SidebarLine[] => sidebarLines(props.snapshot(), now());

  const toneColor = (tone: Tone): RGBA => props.palette()[tone];

  return (
    <box flexDirection="column">
      <Index each={lines()}>
        {(line) => (
          <Show
            when={line().right !== undefined}
            fallback={
              <text fg={toneColor(line().tone)}>
                <Show when={line().bold} fallback={line().text}>
                  <b>{line().text}</b>
                </Show>
              </text>
            }
          >
            <box flexDirection="row">
              <text width={LABEL_WIDTH}>
                <span style={{ fg: toneColor(line().bullet ?? 'base') }}>
                  {line().bullet ? '• ' : '  '}
                </span>
                <span style={{ fg: toneColor(line().tone) }}>{line().text}</span>
              </text>
              <text fg={toneColor(line().rightTone ?? 'muted')}>{line().right}</text>
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
  refresh: (sessionID: string) => void;
}): JSX.Element {
  const snapshot = (): KeepaliveSnapshot | undefined => props.snapshots().get(props.sessionID);
  const palette = (): SidebarPalette => paletteFromTheme(props.ctx.theme);
  // Child sessions are never pinged; before a snapshot exists only the TUI's session data can tell.
  const child = (): boolean => Boolean(props.ctx.data.session.get(props.sessionID)?.parentID);

  createEffect(() => {
    const { sessionID } = props;
    props.load(sessionID);
    const timer = setInterval(() => {
      if (!child()) props.refresh(sessionID);
    }, SIDEBAR_REFRESH_MS);
    onCleanup(() => {
      clearInterval(timer);
    });
  });
  // Whether there is anything to show never depends on the clock, so the ticking child only exists while visible.
  const visible = (): boolean => !child() && sidebarLines(snapshot(), 0).length > 0;

  return (
    <Show when={visible()}>
      <CacheLines palette={palette} snapshot={snapshot} />
    </Show>
  );
}

/** Claims the `sidebar.content` slot with the cache section; returns the disposer. */
function registerSidebar(
  ctx: Plugin.Context,
  snapshots: () => ReadonlyMap<string, KeepaliveSnapshot>,
  load: (sessionID: string) => void,
  refresh: (sessionID: string) => void
): () => void {
  return ctx.ui.slot({
    append: 'sidebar.content',
    // `input` is reactive: read `sessionID` through it so the section follows session switches.
    render: (input) => (
      <CacheSection
        ctx={ctx}
        sessionID={input.sessionID}
        snapshots={snapshots}
        load={load}
        refresh={refresh}
      />
    ),
  });
}

export type { SidebarPalette };
export { paletteFromTheme, CacheLines, registerSidebar };
