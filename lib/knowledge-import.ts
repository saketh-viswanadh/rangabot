import {
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  realpathSync,
  type Stats,
  unlinkSync,
} from "node:fs";
import { basename, extname, join, resolve } from "node:path";

const allowedKnowledgeExtensions = new Set([".pdf", ".docx", ".txt", ".md", ".html", ".htm"]);

export type KnowledgeImportOutcome = Readonly<{
  name: string;
  status: "copied-private" | "already-in-knowledge";
}>;

type PlannedKnowledgeImport = Readonly<{
  source: string;
  destination: string;
  name: string;
  copy: boolean;
}>;

export class KnowledgeImportError extends Error {
  readonly phase: "preflight" | "copy" | "ingest";
  readonly copied: number;
  readonly retained: readonly string[];
  readonly outcomes: readonly KnowledgeImportOutcome[];

  constructor(input: {
    message: string;
    phase: "preflight" | "copy" | "ingest";
    copied?: number;
    retained?: readonly string[];
    outcomes?: readonly KnowledgeImportOutcome[];
  }) {
    super(input.message);
    this.name = "KnowledgeImportError";
    this.phase = input.phase;
    this.copied = input.copied ?? 0;
    this.retained = Object.freeze([...(input.retained ?? [])]);
    this.outcomes = Object.freeze([...(input.outcomes ?? [])]);
  }
}

function existingStatus(path: string) {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function preflightKnowledgeImport(rawPaths: readonly string[], knowledgeInbox: string) {
  if (rawPaths.length < 1 || rawPaths.length > 20) {
    throw new KnowledgeImportError({ message: "Choose between 1 and 20 supported documents.", phase: "preflight" });
  }
  const destinationNames = new Set<string>();
  const plan: PlannedKnowledgeImport[] = [];
  for (const rawPath of rawPaths) {
    if (typeof rawPath !== "string" || !rawPath.trim()) {
      throw new KnowledgeImportError({ message: "Every selected document needs a valid local path.", phase: "preflight" });
    }
    const requested = resolve(rawPath);
    const requestedStatus = existingStatus(requested);
    if (!requestedStatus || requestedStatus.isSymbolicLink() || !requestedStatus.isFile() || requestedStatus.nlink !== 1) {
      throw new KnowledgeImportError({ message: `${basename(requested)} is not a supported regular document. No selected document was copied.`, phase: "preflight" });
    }
    const source = realpathSync(requested);
    if (source !== requested || !allowedKnowledgeExtensions.has(extname(source).toLowerCase())) {
      throw new KnowledgeImportError({ message: `${basename(requested)} is not a supported regular document. No selected document was copied.`, phase: "preflight" });
    }
    const name = basename(source);
    const destinationKey = name.normalize("NFC").toLocaleLowerCase("en-US");
    if (destinationNames.has(destinationKey)) {
      throw new KnowledgeImportError({ message: `${name} conflicts with another selected filename. No selected document was copied.`, phase: "preflight" });
    }
    destinationNames.add(destinationKey);
    const destination = join(knowledgeInbox, name);
    const copy = resolve(destination) !== source;
    if (copy && existingStatus(destination)) {
      throw new KnowledgeImportError({ message: `${name} already exists in Knowledge. Rename one file or remove the existing copy; no selected document was copied.`, phase: "preflight" });
    }
    plan.push(Object.freeze({ source, destination, name, copy }));
  }
  return Object.freeze(plan);
}

export async function importKnowledgeDocuments<T>(input: {
  paths: readonly string[];
  knowledgeInbox: string;
  ingest(): Promise<T>;
  operations?: Partial<Readonly<{
    copy(source: string, destination: string): void;
    chmodPrivate(path: string): void;
    inspect(path: string): Stats;
    unlink(path: string): void;
  }>>;
}) {
  const plan = preflightKnowledgeImport(input.paths, input.knowledgeInbox);
  const operations = {
    copy: input.operations?.copy ?? ((source: string, destination: string) => copyFileSync(source, destination, constants.COPYFILE_EXCL)),
    chmodPrivate: input.operations?.chmodPrivate ?? ((path: string) => { if (process.platform !== "win32") chmodSync(path, 0o600); }),
    inspect: input.operations?.inspect ?? ((path: string) => lstatSync(path)),
    unlink: input.operations?.unlink ?? ((path: string) => unlinkSync(path)),
  };
  const copied: PlannedKnowledgeImport[] = [];
  try {
    for (const item of plan) {
      if (!item.copy) continue;
      operations.copy(item.source, item.destination);
      try {
        operations.chmodPrivate(item.destination);
        const status = operations.inspect(item.destination);
        if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1
          || (process.platform !== "win32" && (status.mode & 0o077) !== 0)) {
          throw new Error("The private Knowledge copy could not be verified.");
        }
      } catch (error) {
        try { operations.unlink(item.destination); } catch { /* Report retained copies below. */ }
        throw error;
      }
      copied.push(item);
    }
  } catch {
    for (const item of copied.reverse()) {
      try { operations.unlink(item.destination); } catch { /* The retained list below remains truthful. */ }
    }
    const retained = plan.filter((item) => item.copy && existingStatus(item.destination)).map((item) => item.name);
    throw new KnowledgeImportError({
      message: retained.length
        ? `Document copying stopped. ${retained.length} private cop${retained.length === 1 ? "y remains" : "ies remain"} in Knowledge; indexing did not start.`
        : "Document copying stopped and new copies were rolled back. No selected document was retained or indexed.",
      phase: "copy",
      copied: retained.length,
      retained,
    });
  }

  const outcomes = plan.map((item): KnowledgeImportOutcome => Object.freeze({
    name: item.name,
    status: item.copy ? "copied-private" : "already-in-knowledge",
  }));
  try {
    const status = await input.ingest();
    return Object.freeze({ selected: plan.length, copied: copied.length, outcomes: Object.freeze(outcomes), status });
  } catch {
    const retained = plan.map((item) => item.name);
    throw new KnowledgeImportError({
      message: `${retained.length} selected document${retained.length === 1 ? " is" : "s are"} in Knowledge, but local processing did not finish. They were retained; retry Knowledge processing before assuming they are searchable.`,
      phase: "ingest",
      copied: copied.length,
      retained,
      outcomes,
    });
  }
}
