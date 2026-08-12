import { lstatSync, readdirSync } from "node:fs";
import { collectDesktopArtifactFiles } from "../../lib/desktop-artifact-identity.ts";

const resourceRoot = process.argv[2];
if (!resourceRoot) throw new Error("Resource root is required.");
const patched = lstatSync(`${resourceRoot}/app.asar`);
if (!patched.isDirectory() || readdirSync(`${resourceRoot}/app.asar`).length === 0) {
  throw new Error("Electron did not expose the ASAR fixture through its virtual filesystem.");
}
const appAsarEntries = collectDesktopArtifactFiles(resourceRoot).filter(({ path }) => path.startsWith("app.asar"));
if (appAsarEntries.length !== 1 || appAsarEntries[0]?.path !== "app.asar" || appAsarEntries[0].bytes <= 0) {
  throw new Error(`Desktop identity did not inventory one raw ASAR file: ${JSON.stringify(appAsarEntries)}`);
}
console.log(JSON.stringify(appAsarEntries[0]));
