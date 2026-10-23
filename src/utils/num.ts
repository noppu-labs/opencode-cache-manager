/** The value when it is a finite number, otherwise `undefined`. */
export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
