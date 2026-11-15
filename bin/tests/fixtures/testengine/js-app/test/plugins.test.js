import { lazy } from "../src/plugins.js";
test("lazy", async () => expect((await lazy()).inc(1)).toBe(2));
