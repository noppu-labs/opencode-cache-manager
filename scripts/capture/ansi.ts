import { type CapturedFrame, type CapturedSpan, RGBA, TextAttributes } from '@opentui/core';

const ESC_BYTE = '\u001B';
const ESC = `${ESC_BYTE}[`;
/** Regex source of one SGR sequence; built from a string so the pattern holds no control-character escape. */
const SGR_PATTERN = `${ESC_BYTE}\\[[0-9;]*m`;
const RESET = `${ESC}0m`;

const SGR_BOLD = 1;
const SGR_DIM = 2;
const SGR_ITALIC = 3;
const SGR_UNDERLINE = 4;
const SGR_FOREGROUND = 38;
const SGR_BACKGROUND = 48;
/** Position of the alpha channel in `RGBA.toInts()`. */
const ALPHA_INDEX = 3;

/** The OpenTUI text attributes mapped to SGR; any other attribute bit is dropped from the image. */
const ATTRIBUTE_CODES: readonly (readonly [number, number])[] = [
  [TextAttributes.BOLD, SGR_BOLD],
  [TextAttributes.DIM, SGR_DIM],
  [TextAttributes.ITALIC, SGR_ITALIC],
  [TextAttributes.UNDERLINE, SGR_UNDERLINE],
];

interface TextPart {
  text: string;
  /** `#rrggbb` */
  fg: string;
}

function sgrColor(color: RGBA, layer: typeof SGR_FOREGROUND | typeof SGR_BACKGROUND): string {
  const [red, green, blue, alpha] = color.toInts();
  return alpha === 0 ? '' : `${ESC}${layer};2;${red};${green};${blue}m`;
}

function sgrAttributes(attributes: number): string {
  // oxlint-disable-next-line eslint/no-bitwise -- reads the attribute bit flags of a captured frame
  return ATTRIBUTE_CODES.filter(([bit]) => (attributes & bit) !== 0)
    .map(([, code]) => `${ESC}${code}m`)
    .join('');
}

/*
 * Attributes go before colours: freeze starts a new text run at each SGR code
 * and only the last one before the text keeps the colour.
 */
function spanToAnsi(span: CapturedSpan): string {
  return `${RESET}${sgrAttributes(span.attributes)}${sgrColor(span.fg, SGR_FOREGROUND)}${sgrColor(span.bg, SGR_BACKGROUND)}${span.text}`;
}

/** A run of cells the component did not paint: no background and no glyph. */
function isUnpainted(span: CapturedSpan): boolean {
  return span.bg.toInts()[ALPHA_INDEX] === 0 && span.text.trim() === '';
}

/** Drops the unpainted rows above and below the component: the test terminal around it. */
function frameToAnsi(frame: CapturedFrame): string[] {
  const painted = frame.lines.map((line) => !line.spans.every(isUnpainted));
  const first = painted.indexOf(true);
  if (first === -1) return [];
  return frame.lines
    .slice(first, painted.lastIndexOf(true) + 1)
    .map((line) => `${line.spans.map(spanToAnsi).join('')}${RESET}`);
}

/** One ANSI row of coloured text. */
function textRow(parts: readonly TextPart[]): string {
  const text = parts
    .map((part) => `${sgrColor(RGBA.fromHex(part.fg), SGR_FOREGROUND)}${part.text}`)
    .join('');
  return `${text}${RESET}`;
}

/** The visible text of an ANSI row, with trailing padding removed. */
function stripAnsi(row: string): string {
  return row.replaceAll(new RegExp(SGR_PATTERN, 'gu'), '').trimEnd();
}

/** The text of every bold span in rows from `frameToAnsi`, in order; spans with no visible text are left out. */
function boldRuns(rows: readonly string[]): string[] {
  const span = new RegExp(
    `${ESC_BYTE}\\[0m(?<codes>(?:${SGR_PATTERN})*)(?<text>[^${ESC_BYTE}]*)`,
    'gu'
  );
  const runs: string[] = [];
  for (const row of rows) {
    for (const { groups } of row.matchAll(span)) {
      const { codes = '', text = '' } = groups ?? {};
      if (codes.includes(`${ESC}${SGR_BOLD}m`) && text.trim() !== '') runs.push(text);
    }
  }
  return runs;
}

/** Charm's freeze 0.2 drops SGR bold: marks the SVG text runs that are bold in the ANSI rows it was made from. */
function restoreBold(svg: string, rows: readonly string[]): string {
  let out = svg;
  for (const text of new Set(boldRuns(rows))) {
    out = out.replaceAll(`>${text}</tspan>`, ` font-weight="bold">${text}</tspan>`);
  }
  return out;
}

export type { TextPart };
export { restoreBold, boldRuns, frameToAnsi, textRow, stripAnsi };
