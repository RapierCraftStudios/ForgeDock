function scale(value: number, factor = 2): number {
  return value * factor;
}

export function total(values: number[]): number {
  let sum = 0;
  for (const v of values) sum += scale(v);
  return sum;
}
