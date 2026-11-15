import { add } from "./util/math.js";
import { money } from "@sample/shared";
import rates from "../data/rates.json" with { type: "json" };
export const total = (items) => money(items.reduce(add, 0) * (1 + rates.tax));
