import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export const defaultKnowledgeDoctorTimeoutMs = 30_000;

export function getKnowledgeDoctorTimeoutMs(value = process.env.KNOWLEDGE_DOCTOR_TIMEOUT_MS) {
  if (value === undefined || value === "") return defaultKnowledgeDoctorTimeoutMs;
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 300_000) {
    throw new Error("KNOWLEDGE_DOCTOR_TIMEOUT_MS must be an integer from 1000 to 300000 milliseconds.");
  }
  return timeout;
}

type HashFile = (path: string, signal: AbortSignal) => Promise<string>;

async function hashFile(path: string, signal: AbortSignal) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  return hash.digest("hex");
}

export async function inspectKnowledgeFileHashes(paths: string[], timeoutMs: number, hash: HashFile = hashFile) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Knowledge Doctor deep scan timed out.")), timeoutMs);
  const files: Array<{ path: string; sha256: string }> = [];
  try {
    for (const path of paths) files.push({ path, sha256: await hash(path, controller.signal) });
    return { complete: true as const, files };
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    return { complete: false as const, files };
  } finally {
    clearTimeout(timer);
  }
}
