import { type CapturedFrame, type CapturedSpan, RGBA, TextAttributes } from '@opentui/core';

const ESC = '\u001b[';
const RESET = `${ESC}0m`;

/** The OpenTUI text attributes mapped to SGR; any other attribute bit is dropped from the image. */
const ATTRIBUTE_CODES: ReadonlyArray<readonly [number, number]> = [
  [TextAttributes.BOLD, 1],
  [TextAttributes.DIM, 2],
  [TextAttributes.ITALIC, 3],
  [TextAttributes.UNDERLINE, 4],
];

export interface TextPart {
  text: string;
  /** `#rrggbb` */
  fg: string;
}

function sgrColor(color: RGBA, layer: 38 | 48): string {
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
  return `${RESET}${sgrAttributes(span.attributes)}${sgrColor(span.fg, 38)}${sgrColor(span.bg, 48)}${span.text}`;
}

/** A run of cells the component did not paint: no background and no glyph. */
function isUnpainted(span: CapturedSpan): boolean {
  return span.bg.toInts()[3] === 0 && span.text.trim() === '';
}

/** Drops the unpainted rows above and below the component: the test terminal around it. */
export function frameToAnsi(frame: CapturedFrame): string[] {
  const painted = frame.lines.map((line) => !line.spans.every(isUnpainted));
  const first = painted.indexOf(true);
  if (first === -1) return [];
  return frame.lines
    .slice(first, painted.lastIndexOf(true) + 1)
    .map((line) => `${line.spans.map(spanToAnsi).join('')}${RESET}`);
}

/** One ANSI row of coloured text. */
export function textRow(parts: readonly TextPart[]): string {
  const text = parts.map((part) => `${sgrColor(RGBA.fromHex(part.fg), 38)}${part.text}`).join('');
  return `${text}${RESET}`;
}

/** The visible text of an ANSI row, with trailing padding removed. */
export function stripAnsi(row: string): string {
  return row.replace(/\u001b\[[0-9;]*m/g, '').trimEnd();
}
