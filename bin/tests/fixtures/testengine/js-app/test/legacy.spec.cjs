const { inc } = require("../src/legacy.cjs");
test("inc", () => expect(inc(1)).toBe(2));
