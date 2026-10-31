/** @jsxImportSource @opentui/solid */
import { RGBA, TextAttributes } from '@opentui/core';
import { For, type JSX } from 'solid-js';

/*
 * A lookalike of OpenCode's `dialog.select` for the README image. The layout is
 * ours; each dimension and colour comes from OpenCode v2.2.1 (tag v2.2.1,
 * commit 3ebcf9a), with the "new-designs" experiment off, as it is by default:
 * packages/tui/src/ui/dialog.tsx and packages/tui/src/ui/dialog-select.tsx.
 */

/** `dialogWidth('medium')`; plugin dialogs open at medium size. */
const DIALOG_WIDTH = 60;
/** `Dialog`'s paddingTop. */
const DIALOG_PADDING_TOP = 1;
/**
 * Column of the title, the input, the section headers and the row titles:
 * `DIALOG_LIST_INSET` (4). The header is `DialogLayout`'s `DIALOG_INSET` (3) plus
 * 1; the list is the scrollbox's 1 plus the row's `DIALOG_LIST_INSET - 1`.
 * (The row title's own `paddingLeft={3}` has no effect on an OpenTUI 0.7 text.)
 */
const TEXT_INSET = 4;
/** The scrollbox's paddingLeft and paddingRight: the selected row's highlight stops one cell short of each edge. */
const LIST_INSET = 1;
/** Blank rows between the title and the input: the input box's paddingTop. */
const INPUT_GAP = 1;
/** Blank rows between the input and the list (`DialogLayout`'s gap) and above every section header but the first. */
const SECTION_GAP = 1;
/**
 * Blank rows under the list: `DialogLayout`'s gap before the empty legacy footer
 * box (a select with no footer and no actions) plus its paddingBottom.
 */
const BOTTOM_GAP = 2;

/**
 * OpenCode's default theme ("opencode"), dark mode, as the `dialog` surface
 * resolves it: packages/tui/src/theme/assets/v2/opencode.json at v2.2.1, through
 * `resolveThemeDocument(…).surface('dialog')` from @opencode/theme. Each comment
 * names the theme path dialog.tsx or dialog-select.tsx reads for that element.
 */
const DIALOG_THEME = {
  /** `background.base`: the dialog, and the focused input (`background.formfield.focused`). */
  background: '#141414',
  /**
   * `text.formfield.focused`: the input's cursor colour. The cursor is the
   * terminal's (block by default, packages/tui/src/config/index.tsx); the image
   * draws the letter under it in the dialog background.
   */
  cursor: '#fab283',
  /** `hue.accent[200]`: section headers, bold. */
  sectionHeader: '#9d7cd8',
  /** `background.action.primary.focused`: the selected row. */
  selectedBackground: '#fab283',
  /** `text.action.primary.focused`: the selected row's title, bold. */
  selectedText: '#0a0a0a',
  /** `text.base`: the title (bold) and the rows. */
  text: '#eeeeee',
  /** `text.muted`: `esc` and the input placeholder. */
  textMuted: '#808080',
} as const;

const color = (key: keyof typeof DIALOG_THEME): RGBA => RGBA.fromHex(DIALOG_THEME[key]);
const TRANSPARENT = RGBA.fromInts(0, 0, 0, 0);

interface PickerOption {
  title: string;
  value: string;
  category: string;
}

/** The options grouped by category, in order of first appearance, as `DialogSelect` groups them. */
function sections(options: readonly PickerOption[]): [string, PickerOption[]][] {
  const grouped = new Map<string, PickerOption[]>();
  for (const option of options) {
    grouped.set(option.category, [...(grouped.get(option.category) ?? []), option]);
  }
  return [...grouped];
}

function PickerDialog(props: {
  title: string;
  placeholder: string;
  options: readonly PickerOption[];
  /** Value of the highlighted row. */
  selected: string;
}): JSX.Element {
  return (
    <box
      width={DIALOG_WIDTH}
      backgroundColor={color('background')}
      paddingTop={DIALOG_PADDING_TOP}
      paddingBottom={BOTTOM_GAP}
    >
      <box
        flexDirection="row"
        justifyContent="space-between"
        paddingLeft={TEXT_INSET}
        paddingRight={TEXT_INSET}
      >
        <text fg={color('text')} attributes={TextAttributes.BOLD}>
          {props.title}
        </text>
        <text fg={color('textMuted')}>esc</text>
      </box>
      <box paddingLeft={TEXT_INSET} paddingTop={INPUT_GAP} paddingBottom={SECTION_GAP}>
        <text>
          <span style={{ bg: color('cursor'), fg: color('background') }}>
            {props.placeholder.slice(0, 1)}
          </span>
          <span style={{ fg: color('textMuted') }}>{props.placeholder.slice(1)}</span>
        </text>
      </box>
      <For each={sections(props.options)}>
        {([category, options], index) => (
          <box paddingTop={index() === 0 ? 0 : SECTION_GAP}>
            <box paddingLeft={TEXT_INSET}>
              <text fg={color('sectionHeader')} attributes={TextAttributes.BOLD}>
                {category}
              </text>
            </box>
            <For each={options}>
              {(option) => {
                const active = option.value === props.selected;
                return (
                  <box
                    marginLeft={LIST_INSET}
                    marginRight={LIST_INSET}
                    paddingLeft={TEXT_INSET - LIST_INSET}
                    backgroundColor={active ? color('selectedBackground') : TRANSPARENT}
                  >
                    <text
                      fg={color(active ? 'selectedText' : 'text')}
                      attributes={active ? TextAttributes.BOLD : TextAttributes.NONE}
                    >
                      {option.title}
                    </text>
                  </box>
                );
              }}
            </For>
          </box>
        )}
      </For>
    </box>
  );
}

export type { PickerOption };
export { DIALOG_WIDTH, PickerDialog };
