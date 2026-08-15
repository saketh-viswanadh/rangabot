import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const approvedAssets = new Map([
  ["public/brand/rangabot-primary-64.png", "6ed05546be06b55e13dbca4d4a65f4ab1b70e749f3d76e0b4f03be7cc521676a"],
  ["public/brand/rangabot-primary-192.png", "49bd26265e89c51cbfcca0fe3fdf4ca46d79da743cbef5ee390c2f9e5e47fd87"],
  ["public/brand/rangabot-primary-512.png", "9d46001713e78a395176fb6de2cfd41a234e5b9b5e06ff8c680421259a575f9d"],
  ["public/brand/rangabot-chat-mark.svg", "cee22b7cf919a0e90408318269e15d43ac6955b26e1b9ec6eb313687db3b98b5"],
  ["public/brand/rangabot-chat-mark-light.svg", "dc5825b6be05b9e99f9b4172ec40ae765fa3f9026d01f58235468bffe0bad657"],
  ["public/brand/rangabot-chat-mark-dark.svg", "69a6ad4f3e77a399ad0794562f9df040122f97dd87767bb46dd4ad384f79dfd6"],
  ["public/brand/rangabot-spark.svg", "18d6bb0e9d3b50c084d3517d1f775c1bbaf5e7ce9c9e247892a595242ad76174"],
  ["desktop/assets/rangabot-primary-1024.png", "52b471b2c9d83d39f5d39c908e1e49dd14cd42ca083d57c3f454739bfa5744a5"],
  ["desktop/assets/rangabot.icns", "87ddbd491cc954cac32c2f31ba9840fe5f99273b453c48122f38a2156a1ad910"],
]);

function sha256(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function pngDimensions(path: string) {
  const bytes = readFileSync(path);
  assert.equal(bytes.subarray(1, 4).toString("ascii"), "PNG", `${path} is not a PNG`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test("binds the runtime identity to the exact Founder-approved assets", () => {
  for (const [path, digest] of approvedAssets) assert.equal(sha256(path), digest, path);
  for (const size of [64, 192, 512]) {
    assert.deepEqual(pngDimensions(`public/brand/rangabot-primary-${size}.png`), { width: size, height: size });
  }
  assert.deepEqual(pngDimensions("desktop/assets/rangabot-primary-1024.png"), { width: 1024, height: 1024 });
  assert.equal(readFileSync("desktop/assets/rangabot.icns").subarray(0, 4).toString("ascii"), "icns");
});

test("keeps compact vector marks local, titled and free of executable or remote content", () => {
  for (const name of ["rangabot-chat-mark.svg", "rangabot-chat-mark-light.svg", "rangabot-chat-mark-dark.svg", "rangabot-spark.svg"]) {
    const source = readFileSync(`public/brand/${name}`, "utf8");
    assert.match(source, /<svg[^>]+viewBox=/, name);
    assert.match(source, /<title\b/, name);
    assert.doesNotMatch(source, /<script\b|<foreignObject\b|\b(?:href|src)=["']https?:/i, name);
  }
});

test("uses the expressive mark for identity and the compact mark only for assistant turns", () => {
  const page = readFileSync("app/page.tsx", "utf8");
  const brandComponent = readFileSync("app/components/brand-mark.tsx", "utf8");
  const styles = readFileSync("app/globals.css", "utf8");
  const mastery = readFileSync("app/mastery/page.tsx", "utf8");

  assert.match(page, /<PrimaryBrandMark className="brand-mark"/);
  assert.match(mastery, /<PrimaryBrandMark className="core-mark" large/);
  assert.match(page, /message\.role === "assistant" && <ChatBrandMark className=/);
  assert.equal((page.match(/<ChatBrandMark\b/g) ?? []).length, 1, "The chat mark must not become general decoration");
  assert.match(page, /welcomePreferences\.mode !== "books" && <ConversationSpark className="welcome-spark"/);
  assert.match(page, /<ConversationSpark className="thinking-spark"/);
  assert.doesNotMatch(page, /ranga-scene|welcome-orbit|onPointerMove=\{followCursor\}/);
  assert.match(brandComponent, /primary-brand-mark/);
  assert.match(brandComponent, /chat-brand-mark/);
  assert.match(styles, /\.chat-brand-mark[^}]*rangabot-chat-mark-light\.svg/);
  assert.match(styles, /\[data-appearance="dark"\] \.chat-brand-mark[^}]*rangabot-chat-mark-dark\.svg/);
  assert.doesNotMatch(styles, /\/ranga\/ranga-idle\.png/);
});

test("binds browser and native packaging metadata to the primary mark", () => {
  const layout = readFileSync("app/layout.tsx", "utf8");
  const forge = readFileSync("forge.config.cjs", "utf8");
  const finalizer = readFileSync("scripts/finalize-desktop-package.ts", "utf8");

  assert.match(layout, /icons:\s*\{/);
  assert.match(layout, /rangabot-primary-64\.png/);
  assert.match(layout, /rangabot-primary-192\.png/);
  assert.match(forge, /icon:\s*path\.resolve\(__dirname, "desktop", "assets", "rangabot\.icns"\)/);
  for (const asset of [
    "rangabot-primary-64.png",
    "rangabot-primary-192.png",
    "rangabot-primary-512.png",
    "rangabot-chat-mark-light.svg",
    "rangabot-chat-mark-dark.svg",
    "rangabot-spark.svg",
  ]) assert.match(finalizer, new RegExp(asset.replace(".", "\\.")), asset);
});

test("records provenance, intended surfaces and the proprietary rights boundary", () => {
  const provenance = readFileSync("public/brand/README.md", "utf8");
  const branding = readFileSync("BRANDING.md", "utf8");

  assert.match(provenance, /Founder-approved Rangabot identity set finalized on 2026-08-14/);
  assert.match(provenance, /assistant messages at 18–24 px/);
  assert.match(provenance, /SHA-256/);
  assert.match(provenance, /proprietary Rangabot identity assets/);
  assert.match(provenance, /reserves all trademark rights/);
  assert.match(provenance, /No redistribution license is granted/);
  assert.match(branding, /public\/brand\/rangabot-primary-512\.png/);
  assert.doesNotMatch(branding, /new identity files (?:are|remain) licensed under/i);
  assert.equal(existsSync("public/brand/LICENSE.md"), false, "No redistribution license is granted for the new identity");
});

test("uses one canonical README mark and preserves the public sharing-card boundary", () => {
  const readme = readFileSync("README.md", "utf8");
  const media = readFileSync("docs/media/README.md", "utf8");
  const manifest = readFileSync("docs/media/brand/BRAND-ASSET-MANIFEST.md", "utf8");
  const launch = readFileSync("docs/open-source-launch.md", "utf8");

  assert.match(readme, /<p align="center">[\s\S]*public\/brand\/rangabot-primary-512\.png/);
  assert.match(readme, /docs\/media\/brand\/BRAND-ASSET-MANIFEST\.md/);
  assert.match(media, /\.\.\/\.\.\/public\/brand\/rangabot-primary-512\.png/);
  assert.match(media, /brand\/BRAND-ASSET-MANIFEST\.md/);
  assert.match(manifest, /public\/brand\/rangabot-primary-\{64,192,512\}\.png/);
  assert.match(manifest, /proprietary Rangabot assets/);
  assert.match(manifest, /no redistribution license is granted/);
  assert.equal(existsSync("docs/media/brand/rangabot-primary-512.png"), false, "Brand docs must not duplicate the product asset");
  assert.match(launch, /- \[x\] Classify the new `public\/brand\/` identity asset as proprietary Rangabot branding/);
});
