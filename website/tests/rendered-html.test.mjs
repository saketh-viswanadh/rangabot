import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${pathname}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the finished Rangabot home page", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Rangabot — extraordinary capability from ordinary machines<\/title>/i);
  assert.match(html, /Your machine\./);
  assert.match(html, /Your models\./);
  assert.match(html, /Their full potential\./);
  assert.match(html, /The Rangabot charter/);
  assert.match(html, /Local first is a boundary/);
  assert.match(html, /Path to Mastery/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("renders every approved public route", async () => {
  const routes = new Map([
    ["/charter", "Extraordinary capability from ordinary machines"],
    ["/product", "More than a model"],
    ["/showcase", "See the work"],
    ["/mastery", "Progress that can be challenged"],
    ["/evidence", "Numbers with names"],
    ["/privacy", "Local by design"],
    ["/docs", "Start small"],
    ["/community", "Craft one capability well"],
    ["/download", "Bring Ranga home"],
  ]);

  for (const [pathname, expected] of routes) {
    const response = await render(pathname);
    assert.equal(response.status, 200, pathname);
    assert.match(await response.text(), new RegExp(expected, "i"), pathname);
  }
});

test("renders the canonical charter and current mastery evidence", async () => {
  const [charterResponse, masteryResponse] = await Promise.all([render("/charter"), render("/mastery")]);
  const charterHtml = await charterResponse.text();
  const masteryHtml = await masteryResponse.text();
  assert.match(charterHtml, /Local first, not local only/);
  assert.match(charterHtml, /Capabilities are earned through evidence/);
  assert.match(charterHtml, /Meaningful work is the final measure/);
  assert.match(masteryHtml, /Model Steward/);
  assert.match(masteryHtml, /Open Platform/);
  assert.match(masteryHtml, /7(?:<!-- -->)? of (?:<!-- -->)?45(?:<!-- -->)? fully unlocked/);
  assert.match(masteryHtml, /2026-08-08/);
});

test("keeps the mastery summary constrained beside a flexible path list", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(css, /\.mastery-summary-grid\s*\{[^}]*grid-template-columns:\s*minmax\(190px, 240px\)\s+minmax\(0, 1fr\)/s);
  assert.match(css, /\.mastery-summary-grid\s*\{[^}]*align-items:\s*start/s);
  assert.match(css, /\.readiness-disc\s*\{[^}]*width:\s*min\(100%, 220px\)/s);
  assert.match(css, /\.mastery-path\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)\s+auto/s);
});

test("keeps primary navigation usable without client-side routing", async () => {
  const response = await render();
  const html = await response.text();
  const internalPaths = [...html.matchAll(/href="(\/[^"]*)"/g)]
    .map((match) => match[1].split("#")[0])
    .filter((pathname) => !pathname.startsWith("/_next/") && !pathname.startsWith("/ranga/") && !pathname.startsWith("/media/"));

  for (const pathname of new Set(internalPaths)) {
    const destination = await render(pathname);
    assert.equal(destination.status, 200, `navigation target ${pathname}`);
  }

  const sourceFiles = [
    "../app/page.tsx",
    "../app/product/page.tsx",
    "../app/community/page.tsx",
    "../components/SiteHeader.tsx",
    "../components/SiteFooter.tsx",
  ];
  const sources = await Promise.all(sourceFiles.map((pathname) => readFile(new URL(pathname, import.meta.url), "utf8")));
  assert.doesNotMatch(sources.join("\n"), /next\/link|<Link\b/);
});

test("keeps starter infrastructure and private product data out of the site", async () => {
  const [page, layout, packageJson, hosting] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(page, /_sites-preview|SkeletonPreview|codex-preview/);
  assert.doesNotMatch(layout, /Starter Project|codex-preview/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  const hostingConfig = JSON.parse(hosting);
  assert.match(hostingConfig.project_id, /^appgprj_/);
  assert.equal(hostingConfig.d1, null);
  assert.equal(hostingConfig.r2, null);
  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));

  const combined = `${page}\n${layout}`;
  assert.doesNotMatch(combined, /rangabot\.db|repositories\.json|knowledge\.db|\.env\.local/);
  await assert.rejects(access(new URL("data", root)));
});

test("launches vinext without POSIX-only environment syntax", async () => {
  const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  const runner = await readFile(new URL("build/run-vinext.mjs", root), "utf8");

  for (const script of [packageJson.scripts.dev, packageJson.scripts.build, packageJson.scripts.start]) {
    assert.match(script, /^node build\/run-vinext\.mjs /);
    assert.doesNotMatch(script, /^[A-Z_]+=\S+ /);
  }
  assert.match(runner, /process\.platform === "win32" \? "vinext\.cmd" : "vinext"/);
  assert.match(runner, /WRANGLER_LOG_PATH: "\.wrangler\/wrangler\.log"/);
});
