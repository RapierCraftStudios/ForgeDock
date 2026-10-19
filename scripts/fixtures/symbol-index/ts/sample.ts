import { readFileSync } from "node:fs";

export const LIMIT = 10;

export function load(path: string): string {
  return readFileSync(path, "utf8").slice(0, LIMIT);
}

export class Loader {
  read(path: string): string {
    return load(path);
  }
}
