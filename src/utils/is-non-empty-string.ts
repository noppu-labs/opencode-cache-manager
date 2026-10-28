/** A string that is neither undefined, null nor empty. */
export function isNonEmptyString(value: string | null | undefined): value is string {
  return value !== undefined && value !== null && value !== '';
}
