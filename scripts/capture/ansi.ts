import { type CapturedFrame, type CapturedSpan, RGBA, TextAttributes } from '@opentui/core';

const ESC = '\u001B[';
const RESET = `${ESC}0m`;

const SGR_BOLD = 1;
const SGR_DIM = 2;
const SGR_ITALIC = 3;
const SGR_UNDERLINE = 4;
const SGR_FOREGROUND = 38;
const SGR_BACKGROUND = 48;

/** The OpenTUI text attributes mapped to SGR; any other attribute bit is dropped from the image. */
const ATTRIBUTE_CODES: ReadonlyArray<readonly [number, number]> = [
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
  const [r, g, b, alpha] = color.toInts();
  return alpha === 0 ? '' : `${ESC}${layer};2;${r};${g};${b}m`;
}

function sgrAttributes(attributes: number): string {
  return ATTRIBUTE_CODES.filter(([bit]) => (attributes & bit) !== 0)
    .map(([, code]) => `${ESC}${code}m`)
    .join('');
}

// Attributes go before colours: freeze starts a new text run at each SGR code
// and only the last one before the text keeps the colour.
function spanToAnsi(span: CapturedSpan): string {
  return `${RESET}${sgrAttributes(span.attributes)}${sgrColor(span.fg, SGR_FOREGROUND)}${sgrColor(span.bg, SGR_BACKGROUND)}${span.text}`;
}

/** A run of cells the component did not paint: no background and no glyph. */
function isUnpainted(span: CapturedSpan): boolean {
  const [, , , alpha] = span.bg.toInts();
  return alpha === 0 && span.text.trim() === '';
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
  // oxlint-disable-next-line eslint/no-control-regex -- matching the ESC byte of SGR sequences is the point
  return row.replaceAll(/\u001B\[[0-9;]*m/gu, '').trimEnd();
}

export type { TextPart };
export { frameToAnsi, textRow, stripAnsi };
