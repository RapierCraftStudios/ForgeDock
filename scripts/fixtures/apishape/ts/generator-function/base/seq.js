export function* pairs(items) {
  for (let i = 0; i < items.length; i += 2) yield items.slice(i, i + 2);
}
