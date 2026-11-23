import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { captureVisualCheck, changedRoutes, routeSlug, visualMarkdown } from "./page-capture.mjs";

const cfg = { capture: "pw-shots", viewports: [390, 1440] };
const big = Buffer.alloc(5000, 1);
const mk = (files, rc = 0) => {
  const calls = [];
  return { calls, run: async (a) => { calls.push(a); return { rc, output: "boom" }; }, read: (p) => files[p.split("/").pop()] ?? null, publish: async (fs) => Object.fromEntries(fs.map((f) => [f.name, `https://x/${f.name}`])) };
};

describe("page-capture (#5770)", () => {
  it("slugs routes and finds changed routes", () => {
    assert.equal(routeSlug("/"), "home");
    assert.equal(routeSlug("/site/removal"), "site-removal");
    assert.deepEqual(changedRoutes(["web/app/bot/page.tsx", "src/a.ts"], { routes: [], exclude: [], design_only: [], generated: [], rewrite_threshold: 0.6 }), ["/bot"]);
  });
  it("#5793: design_only app pages are captured; excluded, test and non-app routes-glob files are not", () => {
    const c = { routes: ["src/routes/**"], exclude: ["web/app/x/**"], design_only: ["web/app/dash/**", "web/app/x/**"], generated: [], rewrite_threshold: 0.6 };
    assert.deepEqual(changedRoutes(["web/app/dash/page.tsx", "web/app/dash/page.test.tsx", "web/app/x/page.tsx", "src/routes/a.tsx"], c), ["/dash"]);
  });
  it("captures every route x viewport, publishes and renders markdown", async () => {
    const m = mk({ "bot-390.png": big, "bot-1440.png": big });
    const c = await captureVisualCheck({ cfg, routes: ["/bot"], dir: "/d", ...m });
    assert.deepEqual(c.errors, []);
    assert.deepEqual(c.screenshots, ["https://x/bot-390.png", "https://x/bot-1440.png"]);
    assert.match(m.calls[0].env.FORGE_PAGE_ROUTES, /\/bot/);
    assert.match(visualMarkdown(c), /## Visual check[\s\S]*\[390px\]\(https:\/\/x\/bot-390\.png\)/);
  });
  it("reports a missing render, a blank page, a failing command and a failed upload as errors", async () => {
    const miss = await captureVisualCheck({ cfg, routes: ["/bot"], dir: "/d", ...mk({ "bot-390.png": big }) });
    assert.match(miss.errors[0].error, /render error/);
    const blank = await captureVisualCheck({ cfg, routes: ["/bot"], dir: "/d", ...mk({ "bot-390.png": Buffer.alloc(10), "bot-1440.png": big }) });
    assert.match(blank.errors[0].error, /blank page/);
    const rc = await captureVisualCheck({ cfg, routes: ["/bot"], dir: "/d", ...mk({}, 1) });
    assert.match(rc.errors[0].error, /exited 1/);
    const up = await captureVisualCheck({ cfg, routes: ["/bot"], dir: "/d", ...mk({ "bot-390.png": big, "bot-1440.png": big }), publish: async () => { throw new Error("no push"); } });
    assert.match(up.errors[0].error, /upload.*no push/);
    assert.equal(visualMarkdown(up), "");
  });
  it("is inert without pages.capture", async () => {
    assert.deepEqual((await captureVisualCheck({ cfg: { viewports: [390] }, routes: ["/a"], dir: "/d", ...mk({}) })).errors, []);
  });
});
