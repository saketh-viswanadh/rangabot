import {
  desktopRuntimeEvidenceFromResourceRoot,
  inspectDesktopArtifact,
  type DesktopArtifactVerification,
} from "../../lib/desktop-artifact-identity.ts";
import {
  resolveDesktopResourceBoundary,
  type DesktopResourceBoundary,
} from "./resource-boundary.ts";

export type VerifiedDesktopResources = Readonly<{
  resources: DesktopResourceBoundary;
  artifact: DesktopArtifactVerification;
}>;

export type DesktopResourceVerificationStage =
  | "A10_RESOURCE_BOUNDARY"
  | "A20_RUNTIME_EVIDENCE"
  | "A30_ARTIFACT_INSPECTION"
  | "A41_MANIFEST_INVALID"
  | "A42_MANIFEST_UNAVAILABLE"
  | "A43_IDENTITY_MISMATCH"
  | "A44_RUNTIME_MISMATCH"
  | "A45_RESOURCE_MISMATCH"
  | "A46_PRODUCT_VERSION_MISMATCH"
  | "A47_MAC_BUILD_NUMBER_MISMATCH";

/**
 * Resolves and verifies only immutable packaged resources. This prelude must
 * remain read-only so a missing, mixed or tampered app can be rejected before
 * Electron selects or creates any private runtime path.
 */
export function verifyDesktopResourcesBeforeMutation(input: {
  resourcesPath: string;
  isPackaged: boolean;
  developmentResourceRoot?: string;
  verifyArtifact?: (artifactRoot: string, resourceRoot: string, manifestPath: string) => DesktopArtifactVerification;
  reportStage?: (stage: DesktopResourceVerificationStage) => void;
}): VerifiedDesktopResources {
  input.reportStage?.("A10_RESOURCE_BOUNDARY");
  const resources = resolveDesktopResourceBoundary(input);
  input.reportStage?.("A20_RUNTIME_EVIDENCE");
  const runtime = input.verifyArtifact ? undefined : desktopRuntimeEvidenceFromResourceRoot({ resourceRoot: resources.resourceRoot });
  input.reportStage?.("A30_ARTIFACT_INSPECTION");
  const artifact = input.verifyArtifact
    ? input.verifyArtifact(resources.artifactRoot, resources.resourceRoot, resources.desktopManifestPath)
    : inspectDesktopArtifact({
      resourceRoot: resources.artifactRoot,
      manifestPath: resources.desktopManifestPath,
      runtime,
    });
  if (artifact.state === "unknown" || artifact.state === "mixed") {
    const rejectedStages: Partial<Record<DesktopArtifactVerification["reason"], DesktopResourceVerificationStage>> = {
      "manifest-invalid": "A41_MANIFEST_INVALID",
      "manifest-unavailable": "A42_MANIFEST_UNAVAILABLE",
      "identity-mismatch": "A43_IDENTITY_MISMATCH",
      "runtime-mismatch": "A44_RUNTIME_MISMATCH",
      "resource-mismatch": "A45_RESOURCE_MISMATCH",
      "product-version-mismatch": "A46_PRODUCT_VERSION_MISMATCH",
      "mac-build-number-mismatch": "A47_MAC_BUILD_NUMBER_MISMATCH",
    };
    const rejectedStage = rejectedStages[artifact.reason];
    if (rejectedStage) input.reportStage?.(rejectedStage);
    throw new Error(`Rangabot's packaged resource identity is ${artifact.state} (${artifact.reason}).`);
  }
  return Object.freeze({ resources, artifact });
}
