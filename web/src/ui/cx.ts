/** Joins class names, skipping falsy ones. */
export function cx(...names: (string | false | null | undefined)[]): string | undefined {
  return names.filter(Boolean).join(" ") || undefined;
}
