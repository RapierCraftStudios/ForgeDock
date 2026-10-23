export function toSlug(value: string): string {
  return value.toLowerCase().replace(/ /g, "-");
}
