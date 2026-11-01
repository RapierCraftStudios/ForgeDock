// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Map `items` through async `fn` with at most `limit` in flight; results keep input order. A throw rejects after the in-flight calls settle. */
export async function mapLimit(items, limit, fn) {
  const list = [...items], out = new Array(list.length);
  const width = Math.max(1, Math.min(Math.floor(Number(limit)) || 1, list.length));
  let next = 0, failed = false, error;
  const worker = async () => {
    while (!failed && next < list.length) {
      const i = next++;
      try { out[i] = await fn(list[i], i); } catch (e) { if (!failed) { failed = true; error = e; } }
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  if (failed) throw error;
  return out;
}
