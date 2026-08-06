export const EXPERT_PACK_SCHEMA_VERSION = 1 as const;

export const expertPackPermissions = [
  "approved-dataset:read",
  "approved-repository:read",
  "approved-web:read",
  "artifact-workspace:write",
  "knowledge-vault:read",
  "local-memory:read",
  "local-runtime:execute",
] as const;

export const expertPackSelectionModes = ["automatic", "general", "custom"] as const;
export const expertPackMaturityLevels = ["design", "experimental", "qualified"] as const;
export const expertPackCompatibilityLevels = ["qualified", "experimental", "poor-fit", "incompatible", "not-installed"] as const;
export const expertPackFailureCodes = [
  "cancelled",
  "capability-unavailable",
  "invalid-output",
  "model-unqualified",
  "permission-required",
  "resource-limit",
  "timeout",
  "tool-failure",
] as const;

export type ExpertPackPermission = typeof expertPackPermissions[number];
export type ExpertPackSelectionMode = typeof expertPackSelectionModes[number];
export type ExpertPackMaturity = typeof expertPackMaturityLevels[number];
export type ExpertPackCompatibility = typeof expertPackCompatibilityLevels[number];
export type ExpertPackFailureCode = typeof expertPackFailureCodes[number];

export type ExpertPackManifest = {
  schemaVersion: typeof EXPERT_PACK_SCHEMA_VERSION;
  id: string;
  name: string;
  version: string;
  summary: string;
  maturity: ExpertPackMaturity;
  capabilities: string[];
  permissions: ExpertPackPermission[];
  tools: Array<{
    id: string;
    required: boolean;
    execution: "deterministic" | "model-assisted";
    network: "disabled" | "approved-only";
  }>;
  modelPolicy: {
    selectionModes: ExpertPackSelectionMode[];
    defaultMode: ExpertPackSelectionMode;
    allowRequestOverride: boolean;
    minimumContextTokens: number;
    requiresStructuredOutput: boolean;
    requiresToolCalling: boolean;
  };
  resources: {
    downloadSizeMb: number;
    workingMemoryMb: number;
    maxConcurrentGenerativeModels: 1;
    unloadAfterSeconds: number;
  };
  qualification: {
    suiteId: string;
    suiteVersion: string;
    minimumOverallPassRate: number;
    minimumCategoryPassRate: number;
    requiredCriticalPassRate: 1;
    criticalRepetitions: number;
  };
  uninstall: {
    preserveUserDataByDefault: true;
    removableArtifacts: string[];
  };
};

export type ExpertPackModelAssignment = {
  mode: ExpertPackSelectionMode;
  modelId?: string;
  requestOverride: boolean;
};

export type ExpertPackModelResolution = {
  requested: ExpertPackModelAssignment;
  resolvedModelId: string;
  compatibility: ExpertPackCompatibility;
  qualificationSuiteId?: string;
  reason: string;
};

export type ExpertPackRequest = {
  requestId: string;
  packId: string;
  packVersion: string;
  currentRequest: string;
  grantedPermissions: ExpertPackPermission[];
  modelAssignment: ExpertPackModelAssignment;
  contextReferences: Array<{
    id: string;
    kind: "conversation" | "memory" | "dataset" | "vault" | "repository" | "artifact";
    title: string;
  }>;
};

export type ExpertPackEvidence = {
  id: string;
  kind: "artifact" | "citation" | "code-change" | "finding" | "statistic" | "table";
  source: "approved-dataset" | "approved-memory" | "approved-repository" | "approved-web" | "artifact-render" | "knowledge-vault" | "local-execution";
  locator: string;
  claims: string[];
};

export type ExpertPackResult = {
  requestId: string;
  packId: string;
  packVersion: string;
  status: "success" | "clarification" | "failure" | "cancelled";
  responseProposal?: string;
  clarification?: string;
  evidence: ExpertPackEvidence[];
  modelBackgroundClaims: string[];
  error?: { code: ExpertPackFailureCode; message: string; retryable: boolean };
  receipt: {
    permissionsUsed: ExpertPackPermission[];
    toolsUsed: string[];
    model?: ExpertPackModelResolution;
    modelSwitches: number;
  };
};

export type ExpertPackValidation = { valid: boolean; errors: string[] };

const idPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isBoundedString = (value: unknown, maximum = 160) => typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
const isRate = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const isIntegerBetween = (value: unknown, minimum: number, maximum: number) => Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum;

function exactKeys(value: Record<string, unknown>, allowed: string[], path: string, errors: string[]) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push(`${path}.${key} is not allowed`);
}

function uniqueBoundedStrings(value: unknown, path: string, errors: string[], maximumItems = 32): value is string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximumItems || !value.every((item) => isBoundedString(item, 100))) {
    errors.push(`${path} must contain 1-${maximumItems} bounded strings`);
    return false;
  }
  if (new Set(value).size !== value.length) errors.push(`${path} must not contain duplicates`);
  return true;
}

export function validateExpertPackModelAssignment(value: unknown): ExpertPackValidation {
  const errors: string[] = [];
  if (!isRecord(value)) return { valid: false, errors: ["assignment must be an object"] };
  exactKeys(value, ["mode", "modelId", "requestOverride"], "assignment", errors);
  if (!expertPackSelectionModes.includes(value.mode as ExpertPackSelectionMode)) errors.push("assignment.mode is invalid");
  if (typeof value.requestOverride !== "boolean") errors.push("assignment.requestOverride must be Boolean");
  if (value.mode === "custom" && !isBoundedString(value.modelId, 120)) errors.push("assignment.modelId is required for custom mode");
  if (value.mode !== "custom" && value.modelId !== undefined) errors.push("assignment.modelId is allowed only for custom mode");
  return { valid: errors.length === 0, errors };
}

export function validateExpertPackManifest(value: unknown): ExpertPackValidation {
  const errors: string[] = [];
  if (!isRecord(value)) return { valid: false, errors: ["manifest must be an object"] };
  exactKeys(value, ["schemaVersion", "id", "name", "version", "summary", "maturity", "capabilities", "permissions", "tools", "modelPolicy", "resources", "qualification", "uninstall"], "manifest", errors);

  if (value.schemaVersion !== EXPERT_PACK_SCHEMA_VERSION) errors.push(`manifest.schemaVersion must be ${EXPERT_PACK_SCHEMA_VERSION}`);
  if (!isBoundedString(value.id, 64) || !idPattern.test(String(value.id))) errors.push("manifest.id must be a lowercase kebab-case identifier");
  if (!isBoundedString(value.name, 80)) errors.push("manifest.name is required");
  if (!isBoundedString(value.version, 40) || !versionPattern.test(String(value.version))) errors.push("manifest.version must be semantic versioning");
  if (!isBoundedString(value.summary, 240)) errors.push("manifest.summary is required");
  if (!expertPackMaturityLevels.includes(value.maturity as ExpertPackMaturity)) errors.push("manifest.maturity is invalid");
  uniqueBoundedStrings(value.capabilities, "manifest.capabilities", errors);

  if (uniqueBoundedStrings(value.permissions, "manifest.permissions", errors, 16)) {
    for (const permission of value.permissions) if (!expertPackPermissions.includes(permission as ExpertPackPermission)) errors.push(`manifest.permissions contains unknown scope: ${permission}`);
  }

  if (!Array.isArray(value.tools) || value.tools.length > 32) errors.push("manifest.tools must be a bounded array");
  else {
    const toolIds: string[] = [];
    value.tools.forEach((tool, index) => {
      const path = `manifest.tools[${index}]`;
      if (!isRecord(tool)) return errors.push(`${path} must be an object`);
      exactKeys(tool, ["id", "required", "execution", "network"], path, errors);
      if (!isBoundedString(tool.id, 80) || !idPattern.test(String(tool.id))) errors.push(`${path}.id is invalid`);
      else toolIds.push(String(tool.id));
      if (typeof tool.required !== "boolean") errors.push(`${path}.required must be Boolean`);
      if (!["deterministic", "model-assisted"].includes(String(tool.execution))) errors.push(`${path}.execution is invalid`);
      if (!["disabled", "approved-only"].includes(String(tool.network))) errors.push(`${path}.network is invalid`);
      if (tool.network === "approved-only" && !(value.permissions as unknown[] | undefined)?.includes("approved-web:read")) errors.push(`${path} requires approved-web:read`);
    });
    if (new Set(toolIds).size !== toolIds.length) errors.push("manifest.tools must not contain duplicate ids");
  }

  if (!isRecord(value.modelPolicy)) errors.push("manifest.modelPolicy must be an object");
  else {
    const policy = value.modelPolicy;
    exactKeys(policy, ["selectionModes", "defaultMode", "allowRequestOverride", "minimumContextTokens", "requiresStructuredOutput", "requiresToolCalling"], "manifest.modelPolicy", errors);
    const selectionModes = Array.isArray(policy.selectionModes) ? policy.selectionModes : [];
    if (selectionModes.length !== expertPackSelectionModes.length || !expertPackSelectionModes.every((mode) => selectionModes.includes(mode))) errors.push("manifest.modelPolicy.selectionModes must support automatic, general and custom");
    if (!expertPackSelectionModes.includes(policy.defaultMode as ExpertPackSelectionMode)) errors.push("manifest.modelPolicy.defaultMode is invalid");
    if (typeof policy.allowRequestOverride !== "boolean") errors.push("manifest.modelPolicy.allowRequestOverride must be Boolean");
    if (!isIntegerBetween(policy.minimumContextTokens, 512, 1_000_000)) errors.push("manifest.modelPolicy.minimumContextTokens is invalid");
    if (typeof policy.requiresStructuredOutput !== "boolean") errors.push("manifest.modelPolicy.requiresStructuredOutput must be Boolean");
    if (typeof policy.requiresToolCalling !== "boolean") errors.push("manifest.modelPolicy.requiresToolCalling must be Boolean");
  }

  if (!isRecord(value.resources)) errors.push("manifest.resources must be an object");
  else {
    const resources = value.resources;
    exactKeys(resources, ["downloadSizeMb", "workingMemoryMb", "maxConcurrentGenerativeModels", "unloadAfterSeconds"], "manifest.resources", errors);
    if (!isIntegerBetween(resources.downloadSizeMb, 0, 1_000_000)) errors.push("manifest.resources.downloadSizeMb is invalid");
    if (!isIntegerBetween(resources.workingMemoryMb, 0, 1_000_000)) errors.push("manifest.resources.workingMemoryMb is invalid");
    if (resources.maxConcurrentGenerativeModels !== 1) errors.push("manifest.resources.maxConcurrentGenerativeModels must be 1 in v1");
    if (!isIntegerBetween(resources.unloadAfterSeconds, 0, 86_400)) errors.push("manifest.resources.unloadAfterSeconds is invalid");
  }

  if (!isRecord(value.qualification)) errors.push("manifest.qualification must be an object");
  else {
    const qualification = value.qualification;
    exactKeys(qualification, ["suiteId", "suiteVersion", "minimumOverallPassRate", "minimumCategoryPassRate", "requiredCriticalPassRate", "criticalRepetitions"], "manifest.qualification", errors);
    if (!isBoundedString(qualification.suiteId, 100) || !idPattern.test(String(qualification.suiteId))) errors.push("manifest.qualification.suiteId is invalid");
    if (!isBoundedString(qualification.suiteVersion, 40) || !versionPattern.test(String(qualification.suiteVersion))) errors.push("manifest.qualification.suiteVersion is invalid");
    if (!isRate(qualification.minimumOverallPassRate)) errors.push("manifest.qualification.minimumOverallPassRate is invalid");
    if (!isRate(qualification.minimumCategoryPassRate)) errors.push("manifest.qualification.minimumCategoryPassRate is invalid");
    if (qualification.requiredCriticalPassRate !== 1) errors.push("manifest.qualification.requiredCriticalPassRate must be 1");
    if (!isIntegerBetween(qualification.criticalRepetitions, 1, 20)) errors.push("manifest.qualification.criticalRepetitions is invalid");
  }

  if (!isRecord(value.uninstall)) errors.push("manifest.uninstall must be an object");
  else {
    const uninstall = value.uninstall;
    exactKeys(uninstall, ["preserveUserDataByDefault", "removableArtifacts"], "manifest.uninstall", errors);
    if (uninstall.preserveUserDataByDefault !== true) errors.push("manifest.uninstall.preserveUserDataByDefault must be true");
    if (!Array.isArray(uninstall.removableArtifacts) || uninstall.removableArtifacts.length > 32 || !uninstall.removableArtifacts.every((item) => isBoundedString(item, 100))) errors.push("manifest.uninstall.removableArtifacts must be a bounded string array");
  }

  return { valid: errors.length === 0, errors };
}
