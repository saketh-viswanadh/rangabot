import { LOCAL_PROFILE_CONTEXT_HEADER } from "./local-http-security.ts";
import { getProfileContext, recoveryProfileSessionBindings } from "./profile-context.ts";
import { parseLocalProfileSessionContext } from "./local-session-token.ts";
import { profileOperations, type ProfileOperationKind } from "./profile-operations.ts";

export class StaleProfileRequestError extends Error {
  constructor() {
    super("The active profile changed. Reload this workspace before trying again.");
    this.name = "StaleProfileRequestError";
  }
}

export function profileBindingFromRequest(request: Request) {
  const supplied = parseLocalProfileSessionContext(request.headers.get(LOCAL_PROFILE_CONTEXT_HEADER) ?? undefined);
  const context = getProfileContext();
  if (!supplied || supplied.profileId !== context.binding.profileId || supplied.generation !== context.binding.generation) {
    throw new StaleProfileRequestError();
  }
  return context.binding;
}

export function recoveryProfileBindingFromRequest(request: Request) {
  const supplied = parseLocalProfileSessionContext(request.headers.get(LOCAL_PROFILE_CONTEXT_HEADER) ?? undefined);
  const accepted = recoveryProfileSessionBindings();
  if (!supplied || !accepted.some((binding) => (
    supplied.profileId === binding.profileId && supplied.generation === binding.generation
  ))) {
    throw new StaleProfileRequestError();
  }
  return supplied;
}

export function assertProfileAcceptsExternalUserData() {
  const context = getProfileContext();
  if (!context.setupRequired && context.profile.kind === "testing") {
    throw new Error("Testing profiles accept synthetic data only. External folders, datasets, and imports are disabled here.");
  }
  return context;
}

export async function withProfileRequest<T>(
  request: Request,
  input: { kind: ProfileOperationKind; label: string; cancellable?: boolean },
  callback: (signal: AbortSignal) => Promise<T> | T,
) {
  const binding = profileBindingFromRequest(request);
  const operation = profileOperations.begin({ binding, ...input });
  try {
    const signal = request.signal.aborted
      ? request.signal
      : AbortSignal.any([request.signal, operation.signal]);
    return await callback(signal);
  } finally {
    operation.release();
  }
}
