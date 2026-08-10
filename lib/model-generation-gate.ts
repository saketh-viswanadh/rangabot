import { ProviderError } from "./providers/types.ts";

export const DEFAULT_MAX_ACTIVE_GENERATIONS_PER_MODEL = 1;
export const DEFAULT_MAX_QUEUED_GENERATIONS_PER_MODEL = 4;

export type ModelGenerationLease = {
  release(): void;
};

type PendingGeneration = {
  signal?: AbortSignal;
  resolve(lease: ModelGenerationLease): void;
  reject(error: ProviderError): void;
  removeAbortListener(): void;
};

type ModelQueue = {
  active: number;
  pending: PendingGeneration[];
};

function queuedAbortError(signal: AbortSignal) {
  const reason = signal.reason;
  if (reason instanceof ProviderError) return reason;
  if (reason instanceof DOMException && reason.name === "TimeoutError") {
    return new ProviderError("timeout", "The local model request timed out while waiting for capacity.", { cause: reason });
  }
  return new ProviderError("cancelled", "Generation was stopped while waiting for the local model.", {
    ...(reason instanceof Error ? { cause: reason } : {}),
  });
}

/**
 * Bounds local model work independently for each resolved model id. A lease is
 * held until buffered generation settles or a streaming body closes/cancels.
 */
export class ModelGenerationGate {
  readonly #queues = new Map<string, ModelQueue>();
  readonly maxActivePerModel: number;
  readonly maxQueuedPerModel: number;

  constructor(
    maxActivePerModel = DEFAULT_MAX_ACTIVE_GENERATIONS_PER_MODEL,
    maxQueuedPerModel = DEFAULT_MAX_QUEUED_GENERATIONS_PER_MODEL,
  ) {
    if (!Number.isInteger(maxActivePerModel) || maxActivePerModel < 1) {
      throw new TypeError("maxActivePerModel must be a positive integer.");
    }
    if (!Number.isInteger(maxQueuedPerModel) || maxQueuedPerModel < 0) {
      throw new TypeError("maxQueuedPerModel must be a non-negative integer.");
    }
    this.maxActivePerModel = maxActivePerModel;
    this.maxQueuedPerModel = maxQueuedPerModel;
  }

  acquire(modelId: string, signal?: AbortSignal): Promise<ModelGenerationLease> {
    const key = modelId.trim();
    if (!key) return Promise.reject(new ProviderError("model-missing", "A local model must be selected before generation."));
    if (signal?.aborted) return Promise.reject(queuedAbortError(signal));

    const queue = this.#queues.get(key) ?? { active: 0, pending: [] };
    this.#queues.set(key, queue);
    if (queue.active < this.maxActivePerModel) {
      queue.active += 1;
      return Promise.resolve(this.#lease(key, queue));
    }
    if (queue.pending.length >= this.maxQueuedPerModel) {
      return Promise.reject(new ProviderError(
        "busy",
        "The selected local model is busy and its bounded queue is full. Try again after the active answer finishes.",
      ));
    }

    return new Promise<ModelGenerationLease>((resolve, reject) => {
      let pending: PendingGeneration;
      const onAbort = () => {
        const index = queue.pending.indexOf(pending);
        if (index >= 0) queue.pending.splice(index, 1);
        pending.removeAbortListener();
        this.#deleteIfIdle(key, queue);
        reject(queuedAbortError(signal as AbortSignal));
      };
      pending = {
        signal,
        resolve,
        reject,
        removeAbortListener: () => signal?.removeEventListener("abort", onAbort),
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      queue.pending.push(pending);
    });
  }

  #lease(key: string, queue: ModelQueue): ModelGenerationLease {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.#release(key, queue);
      },
    };
  }

  #release(key: string, queue: ModelQueue) {
    while (queue.pending.length > 0) {
      const next = queue.pending.shift();
      if (!next) break;
      next.removeAbortListener();
      if (next.signal?.aborted) {
        next.reject(queuedAbortError(next.signal));
        continue;
      }
      // The released active slot transfers directly to the next waiter.
      next.resolve(this.#lease(key, queue));
      return;
    }
    queue.active = Math.max(0, queue.active - 1);
    this.#deleteIfIdle(key, queue);
  }

  #deleteIfIdle(key: string, queue: ModelQueue) {
    if (queue.active === 0 && queue.pending.length === 0 && this.#queues.get(key) === queue) {
      this.#queues.delete(key);
    }
  }
}

type RangabotGenerationGlobal = typeof globalThis & {
  __rangabotLocalModelGenerationGate?: ModelGenerationGate;
};

// Route handlers can be compiled as separate server bundles. Process-global
// ownership keeps their shared Ollama runtime under one capacity boundary.
const generationGlobal = globalThis as RangabotGenerationGlobal;
export const localModelGenerationGate = generationGlobal.__rangabotLocalModelGenerationGate
  ?? new ModelGenerationGate();
generationGlobal.__rangabotLocalModelGenerationGate = localModelGenerationGate;
