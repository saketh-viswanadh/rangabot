import { existsSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const generatedTypes = resolve(process.cwd(), ".next", "types");
let removed = 0;
if (existsSync(generatedTypes)) {
  for (const entry of readdirSync(generatedTypes, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/ \d+\.ts$/.test(entry.name)) continue;
    rmSync(resolve(entry.parentPath, entry.name), { force: true });
    removed += 1;
  }
}
console.log(`Removed ${removed} stale duplicate Next.js type file${removed === 1 ? "" : "s"}; live build output was preserved.`);
