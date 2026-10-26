// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Small JSON state file written atomically (temp file + rename), so a crash never leaves it half-written. */
export function jsonStore(path, initial) {
  let data;
  try { data = JSON.parse(readFileSync(path, "utf8")); } catch { data = structuredClone(initial); }
  return {
    get data() { return data; },
    save() {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      renameSync(tmp, path);
    },
  };
}

export function readSecret(path) {
  const v = readFileSync(path, "utf8").trim();
  if (!v) throw new Error(`empty secret file ${path}`);
  return v;
}
