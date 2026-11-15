import { total } from "../src/cart.js";
test("total", () => expect(total([1, 2])).toBe("$3.60"));
