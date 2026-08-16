import { randomUUID } from "node:crypto";

export const profileOperationKinds = [
  "generation",
  "tool-execution",
  "import",
  "export",
  "indexing",
  "dataset-processing",
  "artifact-creation",
  "database-mutation",
  "migration",
  "backup",
  "restore",
  "reset",
  "delete",
] as const;

export type ProfileOperationKind = (typeof profileOperationKinds)[number];

export type ProfileOperationBinding = Readonly<{
  profileId: string;
  generation: number;
}>;

export type ActiveProfileOperation = Readonly<{
  id: string;
  profileId: string;
  generation: number;
  kind: ProfileOperationKind;
  label: string;
  startedAt: string;
  cancellable: boolean;
}>;

export type ProfileOperationHandle = Readonly<{
  operation: ActiveProfileOperation;
  signal: AbortSignal;
  cancel(): boolean;
  release(): void;
}>;

function canonicalLabel(value: string) {
  const label = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (!label || Array.from(label).length > 120 || /[\u0000-\u001f\u007f]/u.test(label)) {
    throw new Error("A bounded profile operation label is required.");
  }
  return label;
}

function validBinding(binding: ProfileOperationBinding) {
  return typeof binding.profileId === "string"
    && (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(binding.profileId)
      || binding.profileId === "legacy")
    && Number.isSafeInteger(binding.generation)
    && binding.generation >= 0;
}

type OwnedOperation = {
  view: ActiveProfileOperation;
  controller: AbortController;
  released: boolean;
};

export class ProfileOperationCoordinator {
  readonly #operations = new Map<string, OwnedOperation>();

  begin(input: {
    binding: ProfileOperationBinding;
    kind: ProfileOperationKind;
    label: string;
    cancellable?: boolean;
  }): ProfileOperationHandle {
    if (!validBinding(input.binding)) throw new Error("A valid active profile binding is required.");
    if (!profileOperationKinds.includes(input.kind)) throw new Error("The profile operation kind is invalid.");
    const controller = new AbortController();
    const view: ActiveProfileOperation = Object.freeze({
      id: randomUUID(),
      profileId: input.binding.profileId,
      generation: input.binding.generation,
      kind: input.kind,
      label: canonicalLabel(input.label),
      startedAt: new Date().toISOString(),
      cancellable: input.cancellable === true,
    });
    const owned: OwnedOperation = { view, controller, released: false };
    this.#operations.set(view.id, owned);
    return Object.freeze({
      operation: view,
      signal: controller.signal,
      cancel: () => {
        if (owned.released || !view.cancellable || controller.signal.aborted) return false;
        controller.abort(new DOMException("The profile operation was cancelled safely.", "AbortError"));
        return true;
      },
      release: () => {
        if (owned.released) return;
        owned.released = true;
        if (this.#operations.get(view.id) === owned) this.#operations.delete(view.id);
      },
    });
  }

  list(profileId?: string): ActiveProfileOperation[] {
    return [...this.#operations.values()]
      .map(({ view }) => view)
      .filter((view) => profileId === undefined || view.profileId === profileId)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id));
  }

  firstBlocker(): ActiveProfileOperation | null {
    return this.list()[0] ?? null;
  }

  cancel(id: string) {
    const owned = this.#operations.get(id);
    if (!owned || !owned.view.cancellable || owned.released || owned.controller.signal.aborted) return false;
    owned.controller.abort(new DOMException("The profile operation was cancelled safely.", "AbortError"));
    return true;
  }
}

type ProfileOperationGlobal = typeof globalThis & {
  __rangabotProfileOperations?: ProfileOperationCoordinator;
};

const operationGlobal = globalThis as ProfileOperationGlobal;
export const profileOperations = operationGlobal.__rangabotProfileOperations ?? new ProfileOperationCoordinator();
operationGlobal.__rangabotProfileOperations = profileOperations;

export async function withProfileOperation<T>(
  input: Parameters<ProfileOperationCoordinator["begin"]>[0],
  callback: (handle: ProfileOperationHandle) => Promise<T> | T,
) {
  const handle = profileOperations.begin(input);
  try {
    return await callback(handle);
  } finally {
    handle.release();
  }
}
