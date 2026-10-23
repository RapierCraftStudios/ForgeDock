function scale(value: number): number {
  return value * 2;
}

export function total(values: number[]): number {
  return values.reduce((sum, v) => sum + scale(v), 0);
}
