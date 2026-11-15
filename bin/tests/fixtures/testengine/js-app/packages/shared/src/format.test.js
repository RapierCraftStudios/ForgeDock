import { money } from "./format.js";
test("money", () => expect(money(1)).toBe("$1.00"));
