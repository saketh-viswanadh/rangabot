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
  "model-missing",
  "model-unqualified",
  "permission-required",
  "provider-failure",
  "provider-unavailable",
  "resource-limit",
  "timeout",
  "tool-failure",
] as const;
export const expertPackWarningCodes = [
  "model-narration-unavailable",
  "narration-grounding-rejected",
] as const;

export type ExpertPackPermission = typeof expertPackPermissions[number];
export type ExpertPackSelectionMode = typeof expertPackSelectionModes[number];
export type ExpertPackMaturity = typeof expertPackMaturityLevels[number];
export type ExpertPackCompatibility = typeof expertPackCompatibilityLevels[number];
export type ExpertPackFailureCode = typeof expertPackFailureCodes[number];
export type ExpertPackWarningCode = typeof expertPackWarningCodes[number];

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

export type ExpertPackGrant = {
  id: string;
  permission: ExpertPackPermission;
  scope: { kind: "request" | "conversation"; id: string };
  resource?: { kind: "dataset" | "repository" | "vault" | "artifact" | "web-domain"; id: string };
};

export type ExpertPackRequest = {
  requestId: string;
  conversationId: string;
  packId: string;
  packVersion: string;
  capability: string;
  currentRequest: string;
  conversation: Array<{ role: "user" | "assistant"; content: string }>;
  grants: ExpertPackGrant[];
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
  localExecution?: {
    engine: "duckdb";
    resourceId: string;
    inputSha256: string;
    querySha256: string;
    readOnly: true;
    externalAccess: false;
    rowLimit: number;
    returnedRows: number;
    truncated: boolean;
    durationMs: number;
  };
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
  warnings: Array<{ code: ExpertPackWarningCode; message: string }>;
  error?: { code: ExpertPackFailureCode; message: string; retryable: boolean };
  receipt: {
    permissionsUsed: ExpertPackPermission[];
    grantIdsUsed: string[];
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

const contextKinds = ["conversation", "memory", "dataset", "vault", "repository", "artifact"] as const;
const evidenceKinds = ["artifact", "citation", "code-change", "finding", "statistic", "table"] as const;
const evidenceSources = ["approved-dataset", "approved-memory", "approved-repository", "approved-web", "artifact-render", "knowledge-vault", "local-execution"] as const;
const resultStatuses = ["success", "clarification", "failure", "cancelled"] as const;

function permissionForEvidenceSource(source: string): ExpertPackPermission | null {
  if (source === "approved-dataset") return "approved-dataset:read";
  if (source === "approved-memory") return "local-memory:read";
  if (source === "approved-repository") return "approved-repository:read";
  if (source === "approved-web") return "approved-web:read";
  if (source === "artifact-render") return "artifact-workspace:write";
  if (source === "knowledge-vault") return "knowledge-vault:read";
  if (source === "local-execution") return "local-runtime:execute";
  return null;
}

export function validateExpertPackRequest(value: unknown, manifest: ExpertPackManifest): ExpertPackValidation {
  const errors: string[] = [];
  if (!isRecord(value)) return { valid: false, errors: ["request must be an object"] };
  exactKeys(value, ["requestId", "conversationId", "packId", "packVersion", "capability", "currentRequest", "conversation", "grants", "modelAssignment", "contextReferences"], "request", errors);
  if (!isBoundedString(value.requestId, 120)) errors.push("request.requestId is required");
  if (!isBoundedString(value.conversationId, 120)) errors.push("request.conversationId is required");
  if (value.packId !== manifest.id || value.packVersion !== manifest.version) errors.push("request pack identity does not match the installed manifest");
  if (!isBoundedString(value.capability, 100) || !manifest.capabilities.includes(String(value.capability))) errors.push("request.capability is not declared by the pack");
  if (!isBoundedString(value.currentRequest, 50_000)) errors.push("request.currentRequest is required");

  if (!Array.isArray(value.conversation) || value.conversation.length < 1 || value.conversation.length > 200) errors.push("request.conversation must contain 1-200 messages");
  else {
    let total = 0;
    value.conversation.forEach((message, index) => {
      const path = `request.conversation[${index}]`;
      if (!isRecord(message)) return errors.push(`${path} must be an object`);
      exactKeys(message, ["role", "content"], path, errors);
      if (message.role !== "user" && message.role !== "assistant") errors.push(`${path}.role is invalid`);
      if (!isBoundedString(message.content, 50_000)) errors.push(`${path}.content is invalid`);
      else total += String(message.content).length;
    });
    if (total > 1_000_000) errors.push("request.conversation exceeds the total content limit");
    const final = value.conversation.at(-1);
    if (!isRecord(final) || final.role !== "user" || final.content !== value.currentRequest) errors.push("request.currentRequest must equal the final user message");
  }

  const grantIds = new Set<string>();
  if (!Array.isArray(value.grants) || value.grants.length < 1 || value.grants.length > 32) errors.push("request.grants must contain 1-32 scoped grants");
  else value.grants.forEach((grant, index) => {
    const path = `request.grants[${index}]`;
    if (!isRecord(grant)) return errors.push(`${path} must be an object`);
    exactKeys(grant, ["id", "permission", "scope", "resource"], path, errors);
    if (!isBoundedString(grant.id, 120) || grantIds.has(String(grant.id))) errors.push(`${path}.id must be unique and bounded`);
    else grantIds.add(String(grant.id));
    if (!manifest.permissions.includes(grant.permission as ExpertPackPermission)) errors.push(`${path}.permission is not declared by the pack`);
    if (!isRecord(grant.scope) || !["request", "conversation"].includes(String(grant.scope.kind)) || !isBoundedString(grant.scope.id, 120)) errors.push(`${path}.scope is invalid`);
    else if ((grant.scope.kind === "request" && grant.scope.id !== value.requestId) || (grant.scope.kind === "conversation" && grant.scope.id !== value.conversationId)) errors.push(`${path}.scope is not bound to this request or conversation`);
    if (grant.resource !== undefined && (!isRecord(grant.resource) || !["dataset", "repository", "vault", "artifact", "web-domain"].includes(String(grant.resource.kind)) || !isBoundedString(grant.resource.id, 240))) errors.push(`${path}.resource is invalid`);
    if (grant.permission === "approved-dataset:read" && (!isRecord(grant.resource) || grant.resource.kind !== "dataset")) errors.push(`${path} must bind approved-dataset:read to one dataset`);
  });

  const references = new Map<string, string>();
  if (!Array.isArray(value.contextReferences) || value.contextReferences.length > 32) errors.push("request.contextReferences must be a bounded array");
  else value.contextReferences.forEach((reference, index) => {
    const path = `request.contextReferences[${index}]`;
    if (!isRecord(reference)) return errors.push(`${path} must be an object`);
    exactKeys(reference, ["id", "kind", "title"], path, errors);
    if (!isBoundedString(reference.id, 240) || !contextKinds.includes(reference.kind as typeof contextKinds[number]) || !isBoundedString(reference.title, 160)) errors.push(`${path} is invalid`);
    else references.set(`${reference.kind}:${reference.id}`, String(reference.id));
  });
  if (Array.isArray(value.grants)) for (const grant of value.grants) {
    if (isRecord(grant) && isRecord(grant.resource) && grant.resource.kind === "dataset" && !references.has(`dataset:${grant.resource.id}`)) errors.push("request dataset grant has no matching context reference");
  }

  const assignment = validateExpertPackModelAssignment(value.modelAssignment);
  errors.push(...assignment.errors.map((error) => `request.modelAssignment: ${error}`));
  if (isRecord(value.modelAssignment)) {
    if (!manifest.modelPolicy.selectionModes.includes(value.modelAssignment.mode as ExpertPackSelectionMode)) errors.push("request.modelAssignment.mode is not supported by this pack");
    if (value.modelAssignment.requestOverride === true && !manifest.modelPolicy.allowRequestOverride) errors.push("request.modelAssignment request overrides are disabled by this pack");
  }
  return { valid: errors.length === 0, errors };
}

export function validateExpertPackResult(value: unknown, manifest: ExpertPackManifest, request: ExpertPackRequest): ExpertPackValidation {
  const errors: string[] = [];
  if (!isRecord(value)) return { valid: false, errors: ["result must be an object"] };
  exactKeys(value, ["requestId", "packId", "packVersion", "status", "responseProposal", "clarification", "evidence", "modelBackgroundClaims", "warnings", "error", "receipt"], "result", errors);
  if (value.requestId !== request.requestId || value.packId !== manifest.id || value.packVersion !== manifest.version) errors.push("result identity does not match the request and installed pack");
  if (!resultStatuses.includes(value.status as typeof resultStatuses[number])) errors.push("result.status is invalid");
  if (value.responseProposal !== undefined && !isBoundedString(value.responseProposal, 100_000)) errors.push("result.responseProposal is invalid");
  if (value.clarification !== undefined && !isBoundedString(value.clarification, 2_000)) errors.push("result.clarification is invalid");
  if (value.status === "success" && (!isBoundedString(value.responseProposal, 100_000) || value.error !== undefined || value.clarification !== undefined)) errors.push("a successful result requires only a response proposal");
  if (value.status === "clarification" && (!isBoundedString(value.clarification, 2_000) || value.responseProposal !== value.clarification || value.error !== undefined)) errors.push("a clarification result requires one matching clarification proposal and no error");
  if ((value.status === "failure" || value.status === "cancelled") && (value.responseProposal !== undefined || value.clarification !== undefined || !isRecord(value.error))) errors.push("failure and cancellation results require an error and no response proposal");
  if (isRecord(value.error)) {
    exactKeys(value.error, ["code", "message", "retryable"], "result.error", errors);
    if (!expertPackFailureCodes.includes(value.error.code as ExpertPackFailureCode) || !isBoundedString(value.error.message, 1_000) || typeof value.error.retryable !== "boolean") errors.push("result.error is invalid");
    if (value.status === "cancelled" && value.error.code !== "cancelled") errors.push("a cancelled result requires the cancelled error code");
    if (value.status === "failure" && value.error.code === "cancelled") errors.push("the cancelled error code requires cancelled status");
    if (value.error.code === "cancelled" && value.error.retryable !== false) errors.push("cancellation is terminal and not retryable");
  }

  const requestGrants = new Map(request.grants.map((grant) => [grant.id, grant]));
  const requestGrantIds = new Set(requestGrants.keys());
  const requestPermissions = new Set(request.grants.map((grant) => grant.permission));
  const usedPermissions = new Set<ExpertPackPermission>();
  const requiredGrantIds = new Set<string>();
  const requiredTools = new Set<string>();
  const evidenceIds = new Set<string>();
  if (!Array.isArray(value.evidence) || value.evidence.length > 32) errors.push("result.evidence must be a bounded array");
  else value.evidence.forEach((evidence, index) => {
    const path = `result.evidence[${index}]`;
    if (!isRecord(evidence)) return errors.push(`${path} must be an object`);
    exactKeys(evidence, ["id", "kind", "source", "locator", "claims", "localExecution"], path, errors);
    if (!isBoundedString(evidence.id, 120) || evidenceIds.has(String(evidence.id)) || !evidenceKinds.includes(evidence.kind as typeof evidenceKinds[number]) || !evidenceSources.includes(evidence.source as typeof evidenceSources[number]) || !isBoundedString(evidence.locator, 1_000)) errors.push(`${path} identity is invalid or duplicated`);
    else evidenceIds.add(String(evidence.id));
    if (!Array.isArray(evidence.claims) || evidence.claims.length < 1 || evidence.claims.length > 32 || !evidence.claims.every((claim) => isBoundedString(claim, 2_000))) errors.push(`${path}.claims is invalid`);
    const permission = permissionForEvidenceSource(String(evidence.source));
    if (permission) usedPermissions.add(permission);
    if (permission && !requestPermissions.has(permission)) errors.push(`${path}.source has no matching request grant`);
    if (evidence.source === "local-execution") {
      usedPermissions.add("approved-dataset:read");
      requiredTools.add("duckdb-readonly");
      const execution = evidence.localExecution;
      if (!isRecord(execution)) errors.push(`${path}.localExecution is required`);
      else {
        exactKeys(execution, ["engine", "resourceId", "inputSha256", "querySha256", "readOnly", "externalAccess", "rowLimit", "returnedRows", "truncated", "durationMs"], `${path}.localExecution`, errors);
        if (execution.engine !== "duckdb" || !isBoundedString(execution.resourceId, 240)
          || typeof execution.inputSha256 !== "string" || !/^[a-f\d]{64}$/.test(execution.inputSha256)
          || typeof execution.querySha256 !== "string" || !/^[a-f\d]{64}$/.test(execution.querySha256)
          || execution.readOnly !== true || execution.externalAccess !== false
          || !isIntegerBetween(execution.rowLimit, 1, 10_000) || !isIntegerBetween(execution.returnedRows, 0, Number(execution.rowLimit) || 0)
          || typeof execution.truncated !== "boolean" || execution.truncated === true && execution.returnedRows !== execution.rowLimit
          || !isIntegerBetween(execution.durationMs, 0, 30_000)) errors.push(`${path}.localExecution is invalid`);
        if (typeof execution.inputSha256 === "string" && typeof execution.querySha256 === "string" && evidence.locator !== `duckdb:${execution.inputSha256}:${execution.querySha256}`) errors.push(`${path}.locator does not match the execution receipt`);
        const resourceGrant = request.grants.find((grant) => grant.permission === "approved-dataset:read" && grant.resource?.kind === "dataset" && grant.resource.id === execution.resourceId);
        if (!resourceGrant) errors.push(`${path}.localExecution resource is not attached to this request`);
        else requiredGrantIds.add(resourceGrant.id);
      }
    } else if (evidence.localExecution !== undefined) errors.push(`${path}.localExecution is allowed only for local-execution evidence`);
  });
  if (value.status === "success" && (!Array.isArray(value.evidence) || value.evidence.length < 1)) errors.push("a successful result requires at least one evidence item");

  if (!Array.isArray(value.modelBackgroundClaims) || value.modelBackgroundClaims.length > 32 || !value.modelBackgroundClaims.every((claim) => isBoundedString(claim, 2_000))) errors.push("result.modelBackgroundClaims must be a bounded array");
  const warningCodes = new Set<string>();
  if (!Array.isArray(value.warnings) || value.warnings.length > 16) errors.push("result.warnings must be a bounded array");
  else value.warnings.forEach((warning, index) => {
    const path = `result.warnings[${index}]`;
    if (!isRecord(warning)) return errors.push(`${path} must be an object`);
    exactKeys(warning, ["code", "message"], path, errors);
    if (!expertPackWarningCodes.includes(warning.code as ExpertPackWarningCode) || warningCodes.has(String(warning.code)) || !isBoundedString(warning.message, 1_000)) errors.push(`${path} is invalid or duplicated`);
    else warningCodes.add(String(warning.code));
  });
  if (!isRecord(value.receipt)) errors.push("result.receipt is required");
  else {
    const receipt = value.receipt;
    exactKeys(receipt, ["permissionsUsed", "grantIdsUsed", "toolsUsed", "model", "modelSwitches"], "result.receipt", errors);
    const permissionsUsed = Array.isArray(receipt.permissionsUsed) ? receipt.permissionsUsed : [];
    const grantIdsUsed = Array.isArray(receipt.grantIdsUsed) ? receipt.grantIdsUsed : [];
    const toolsUsed = Array.isArray(receipt.toolsUsed) ? receipt.toolsUsed : [];
    if (!Array.isArray(receipt.permissionsUsed) || permissionsUsed.length > 16 || new Set(permissionsUsed).size !== permissionsUsed.length || !permissionsUsed.every((permission) => manifest.permissions.includes(permission as ExpertPackPermission) && requestPermissions.has(permission as ExpertPackPermission))) errors.push("result.receipt.permissionsUsed exceeds granted authority, bounds, or uniqueness");
    if (!Array.isArray(receipt.grantIdsUsed) || grantIdsUsed.length > 32 || new Set(grantIdsUsed).size !== grantIdsUsed.length || !grantIdsUsed.every((id) => typeof id === "string" && requestGrantIds.has(id))) errors.push("result.receipt.grantIdsUsed exceeds granted authority, bounds, or uniqueness");
    if (!Array.isArray(receipt.toolsUsed) || toolsUsed.length > 32 || new Set(toolsUsed).size !== toolsUsed.length || !toolsUsed.every((tool) => typeof tool === "string" && manifest.tools.some((declared) => declared.id === tool))) errors.push("result.receipt.toolsUsed contains an undeclared, duplicate, or unbounded tool");
    if (!isIntegerBetween(receipt.modelSwitches, 0, 1)) errors.push("result.receipt.modelSwitches is invalid");
    if (receipt.model !== undefined) {
      if (!isRecord(receipt.model)) errors.push("result.receipt.model is invalid");
      else {
        const model = receipt.model;
        exactKeys(model, ["requested", "resolvedModelId", "compatibility", "qualificationSuiteId", "reason"], "result.receipt.model", errors);
        const assignment = validateExpertPackModelAssignment(model.requested);
        const requestedMatches = isRecord(model.requested)
          && model.requested.mode === request.modelAssignment.mode
          && model.requested.modelId === request.modelAssignment.modelId
          && model.requested.requestOverride === request.modelAssignment.requestOverride;
        if (!assignment.valid || !requestedMatches) errors.push("result.receipt.model.requested does not match the request");
        if (!isBoundedString(model.resolvedModelId, 120) || !expertPackCompatibilityLevels.includes(model.compatibility as ExpertPackCompatibility) || (model.qualificationSuiteId !== undefined && !isBoundedString(model.qualificationSuiteId, 100)) || !isBoundedString(model.reason, 1_000)) errors.push("result.receipt.model resolution is invalid");
        if (model.qualificationSuiteId !== undefined && model.qualificationSuiteId !== manifest.qualification.suiteId) errors.push("result.receipt.model qualification suite does not match the pack");
        if (request.modelAssignment.mode === "custom" && model.resolvedModelId !== request.modelAssignment.modelId) errors.push("result.receipt.model silently changed the requested custom model");
      }
    } else if (Number(receipt.modelSwitches) !== 0) errors.push("result.receipt cannot report a model switch without a model resolution");
    if (Array.isArray(value.modelBackgroundClaims) && value.modelBackgroundClaims.length > 0 && receipt.model === undefined) errors.push("result.modelBackgroundClaims require an inspectable model receipt");
    for (const permission of usedPermissions) if (!permissionsUsed.includes(permission)) errors.push(`result.receipt omits evidence permission: ${permission}`);
    for (const grantId of requiredGrantIds) if (!grantIdsUsed.includes(grantId)) errors.push(`result.receipt omits evidence grant: ${grantId}`);
    for (const tool of requiredTools) if (!toolsUsed.includes(tool)) errors.push(`result.receipt omits evidence tool: ${tool}`);
    for (const permission of permissionsUsed) {
      const hasUsedGrant = grantIdsUsed.some((id) => requestGrants.get(String(id))?.permission === permission);
      if (!hasUsedGrant) errors.push(`result.receipt permission has no matching used grant: ${permission}`);
    }
    for (const id of grantIdsUsed) {
      const grant = requestGrants.get(String(id));
      if (grant && !permissionsUsed.includes(grant.permission)) errors.push(`result.receipt grant has no matching used permission: ${id}`);
    }
    if (toolsUsed.length > 0 && !permissionsUsed.includes("local-runtime:execute")) errors.push("result.receipt tools require local-runtime:execute");
  }
  return { valid: errors.length === 0, errors };
}
