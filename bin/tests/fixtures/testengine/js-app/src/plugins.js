export const load = (name) => import(name);
export const lazy = () => import("./legacy.cjs");
