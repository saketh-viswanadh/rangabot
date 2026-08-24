import { lstatSync } from "node:fs";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";
import {
  inspectProfileRegistry,
  PROFILE_DATA_DIRECTORY_NAME,
  PROFILE_REGISTRY_DIRECTORY_NAME,
} from "./profile-registry.ts";

export const RANGABOT_RESOURCE_ROOT_ENV = "RANGABOT_RESOURCE_ROOT" as const;
export const RANGABOT_DATA_ROOT_ENV = "RANGABOT_DATA_ROOT" as const;

export class RuntimePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimePathError";
  }
}

type RuntimeRootEnvironment = Record<string, string | undefined>;

export type RuntimeRootOptions = {
  cwd?: string;
  environment?: RuntimeRootEnvironment;
};


function pathIsWithin(root: string, path: string) {
  const child = relative(root, path);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

function configuredRoot(environment: RuntimeRootEnvironment, key: string) {
  const value = environment[key];
  if (value === undefined) return undefined;
  if (!value || value !== value.trim() || value.includes("\0")) {
    throw new RuntimePathError(`${key} must be a non-empty absolute path.`);
  }
  if (!isAbsolute(value)) throw new RuntimePathError(`${key} must be an absolute path.`);
  if (value.split(/[\\/]+/).includes("..")) {
    throw new RuntimePathError(`${key} must not contain parent traversal.`);
  }
  const normalized = resolve(value);
  if (normalized !== value) throw new RuntimePathError(`${key} must be an absolute normalized path.`);
  return normalized;
}

function inspectExistingComponents(root: string, path = root, includeRootAncestors = false) {
  const requestedRoot = resolve(root);
  const absolute = resolve(path);
  const boundary = includeRootAncestors ? parse(requestedRoot).root : requestedRoot;
  const components = relative(boundary, absolute).split(sep).filter(Boolean);
  let cursor = boundary;
  for (const component of components) {
    cursor = resolve(cursor, component);
    try {
      const status = lstatSync(/* turbopackIgnore: true */ cursor);
      if (status.isSymbolicLink()) {
        throw new RuntimePathError("Rangabot runtime roots and paths must not contain symbolic links.");
      }
      if (cursor !== absolute && !status.isDirectory()) {
        throw new RuntimePathError("A Rangabot runtime path ancestor is not a directory.");
      }
    } catch (error) {
      if (error instanceof RuntimePathError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return false;
    }
  }
  return true;
}

function requireRoot(path: string, kind: "resource" | "data", mustExist: boolean) {
  const exists = inspectExistingComponents(path, path, true);
  if (!exists) {
    if (mustExist) throw new RuntimePathError(`The configured Rangabot ${kind} root must already exist.`);
    return;
  }
  const status = lstatSync(/* turbopackIgnore: true */ path);
  if (!status.isDirectory()) throw new RuntimePathError(`The Rangabot ${kind} root must be a real directory.`);
}

/**
 * Resolve a fixed app-owned path below one runtime root. Callers pass path
 * components, never user-controlled relative paths. Existing symbolic links
 * are rejected so a packaged resource or private-data lookup cannot escape.
 */
export function resolveRuntimePathWithinRoot(root: string, ...components: string[]) {
  const absoluteRoot = resolve(root);
  for (const component of components) {
    if (!component || component === "." || component === ".." || component.includes("\0")
      || isAbsolute(component) || component.includes("/") || component.includes("\\")) {
      throw new RuntimePathError("Rangabot runtime path components must be fixed names without traversal.");
    }
  }
  const target = resolve(absoluteRoot, ...components);
  if (!pathIsWithin(absoluteRoot, target)) throw new RuntimePathError("Rangabot runtime path escapes its root.");
  inspectExistingComponents(absoluteRoot, target, true);
  return target;
}

function rootsOverlap(left: string, right: string) {
  return pathIsWithin(left, right) || pathIsWithin(right, left);
}

function validateActiveProfileStorageShape(managedDataRoot: string) {
  const activeRoot = resolveActiveProfileDataRoot(managedDataRoot);
  const paths = [
    ["rangabot.db"], ["rangabot-memory.db"], ["datasets.json"], ["repositories.json"],
    ["sql-confirmations.json"], ["dataset-snapshots"], ["artifacts"],
    ["desktop-preferences.json"], ["model-preferences.json"],
    ["onboarding-state.json"],
    ["knowledge", "inbox"], ["knowledge", "processed"], ["knowledge", "indexes", "knowledge.db"],
    ["knowledge", "backups"], ["knowledge", "evaluations", "results"], ["evaluations", "results"],
  ] as const;
  for (const components of paths) resolveRuntimePathWithinRoot(activeRoot, ...components);
}

export function resolveActiveProfileDataRoot(managedDataRoot: string) {
  const inspection = inspectProfileRegistry(managedDataRoot);
  if (inspection.kind === "setup-required") return managedDataRoot;
  const registryRoot = resolveRuntimePathWithinRoot(managedDataRoot, PROFILE_REGISTRY_DIRECTORY_NAME);
  const profilesRoot = resolveRuntimePathWithinRoot(registryRoot, PROFILE_DATA_DIRECTORY_NAME);
  const activeRoot = resolveRuntimePathWithinRoot(profilesRoot, inspection.snapshot.activeProfileId);
  requireRoot(activeRoot, "data", true);
  return activeRoot;
}

export function resolveRuntimePathContract(options: RuntimeRootOptions = {}) {
  const environment = options.environment ?? process.env;
  // Runtime resources are staged explicitly for desktop packaging. Prevent
  // Next file tracing from interpreting the CLI compatibility cwd as a request
  // to copy the entire source checkout into the standalone server payload.
  const cwd = resolve(/* turbopackIgnore: true */ options.cwd ?? process.cwd());
  const configuredResource = configuredRoot(environment, RANGABOT_RESOURCE_ROOT_ENV);
  const configuredData = configuredRoot(environment, RANGABOT_DATA_ROOT_ENV);
  if (Boolean(configuredResource) !== Boolean(configuredData)) {
    throw new RuntimePathError(
      `${RANGABOT_RESOURCE_ROOT_ENV} and ${RANGABOT_DATA_ROOT_ENV} must be supplied together.`,
    );
  }

  // CLI compatibility is explicit: shipped resources resolve from the launch
  // working directory and mutable state remains in its existing ./data tree.
  const resourceRoot = configuredResource ?? cwd;
  const managedDataRoot = configuredData ?? resolveRuntimePathWithinRoot(resourceRoot, "data");
  requireRoot(resourceRoot, "resource", true);
  requireRoot(managedDataRoot, "data", Boolean(configuredData));
  if (configuredResource && configuredData && rootsOverlap(resourceRoot, managedDataRoot)) {
    throw new RuntimePathError("Configured Rangabot resource and data roots must not overlap.");
  }
  validateActiveProfileStorageShape(managedDataRoot);

  const resource = (...components: string[]) => resolveRuntimePathWithinRoot(resourceRoot, ...components);
  const managed = (...components: string[]) => resolveRuntimePathWithinRoot(managedDataRoot, ...components);
  const data = (...components: string[]) => resolveRuntimePathWithinRoot(resolveActiveProfileDataRoot(managedDataRoot), ...components);
  const knowledgeResourceRoot = resource("data", "knowledge");

  const paths = {
    mode: configuredResource ? "configured" as const : "cli" as const,
    resourceRoot,
    managedDataRoot,
    get dataRoot() { return resolveActiveProfileDataRoot(managedDataRoot); },
    profileRegistryRoot: managed(PROFILE_REGISTRY_DIRECTORY_NAME),
    profileRegistry: managed(PROFILE_REGISTRY_DIRECTORY_NAME, "registry.json"),
    profilesRoot: managed(PROFILE_REGISTRY_DIRECTORY_NAME, PROFILE_DATA_DIRECTORY_NAME),
    profileRecoveryRoot: managed(PROFILE_REGISTRY_DIRECTORY_NAME, "recovery"),
    profileTombstonesRoot: managed(PROFILE_REGISTRY_DIRECTORY_NAME, "tombstones"),
    packageJson: resource("package.json"),
    nextCli: resource("node_modules", "next", "dist", "bin", "next"),
    sqlRuntimeWorker: resource("lib", "sql-runtime-worker.cjs"),
    changelog: resource("CHANGELOG.md"),
    knowledgeResourceRoot,
    knowledgeWeeklyBrief: resource("data", "knowledge", "NEW_THIS_WEEK.md"),
    knowledgeMonthlyBrief: resource("data", "knowledge", "NEW_THIS_MONTH.md"),
    knowledgeSourceManifest: resource("data", "knowledge", "SOURCE_MANIFEST.json"),
    knowledgeEvaluationFixtures: resource("data", "knowledge", "evaluations"),
    get conversationDatabase() { return data("rangabot.db"); },
    // Response feedback is deliberately co-located with its canonical turn in
    // the conversation database; it has no second storage or export root.
    get responseFeedbackDatabase() { return data("rangabot.db"); },
    get memoryDatabase() { return data("rangabot-memory.db"); },
    get datasetsRegistry() { return data("datasets.json"); },
    get datasetSemanticContexts() { return data("dataset-semantic-contexts.json"); },
    get repositoriesRegistry() { return data("repositories.json"); },
    get sqlConfirmations() { return data("sql-confirmations.json"); },
    get datasetSnapshots() { return data("dataset-snapshots"); },
    get artifactsRoot() { return data("artifacts"); },
    runtimeLease: managed("rangabot.db-runtime.lock"),
    desktopTemp: managed("tmp"),
    get desktopPreferences() { return data("desktop-preferences.json"); },
    get modelPreferences() { return data("model-preferences.json"); },
    get onboardingState() { return data("onboarding-state.json"); },
    managedModels: managed("models"),
    get knowledgeRoot() { return data("knowledge"); },
    get knowledgeInbox() { return data("knowledge", "inbox"); },
    get knowledgeProcessed() { return data("knowledge", "processed"); },
    get knowledgeIndexes() { return data("knowledge", "indexes"); },
    get knowledgeDatabase() { return data("knowledge", "indexes", "knowledge.db"); },
    get knowledgeBackups() { return data("knowledge", "backups"); },
    get knowledgeEvaluationResults() { return data("knowledge", "evaluations", "results"); },
    get evaluationsRoot() { return data("evaluations"); },
    get evaluationResults() { return data("evaluations", "results"); },
  };
  return Object.freeze(paths);
}

export const runtimePaths = resolveRuntimePathContract();

export function runtimeResourcePath(...components: string[]) {
  return resolveRuntimePathWithinRoot(runtimePaths.resourceRoot, ...components);
}

export function runtimeDataPath(...components: string[]) {
  return resolveRuntimePathWithinRoot(runtimePaths.dataRoot, ...components);
}

export function runtimeManagedDataPath(...components: string[]) {
  return resolveRuntimePathWithinRoot(runtimePaths.managedDataRoot, ...components);
}
