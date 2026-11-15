import { readFileSync } from "node:fs";
import { join } from "node:path";
const sql = readFileSync(join(process.cwd(), "data/schema.sql"), "utf8");
const order = JSON.parse(readFileSync(new URL("fixtures/order.json", import.meta.url), "utf8"));
test("schema", () => expect(sql).toContain(`orders`) && expect(order.id).toBe(1));
