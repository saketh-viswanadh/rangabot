import { rmSync } from "node:fs";
import { resolve } from "node:path";

const generated = resolve(process.cwd(), ".next");
rmSync(generated, { recursive: true, force: true });
console.log(`Removed generated Next.js output: ${generated}`);
