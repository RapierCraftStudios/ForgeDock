export function slugify(value: string): string {
  return value.toLowerCase().replace(/ /g, "-");
}
