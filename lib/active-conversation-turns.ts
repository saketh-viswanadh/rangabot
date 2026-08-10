export type ActiveConversationTurnHandle = {
  signal: AbortSignal;
  release(): void;
};

type ActiveTurn = {
  controller: AbortController;
  removeSignalListeners: Array<() => void>;
};

function cancellationReason() {
  return new DOMException("Generation was stopped.", "AbortError");
}

/** Process-local ownership for currently executing turns; no chat data is stored. */
export class ActiveConversationTurnRegistry {
  readonly #turns = new Map<string, ActiveTurn>();

  register(turnId: string, upstreamSignals: AbortSignal[] = []): ActiveConversationTurnHandle {
    if (this.#turns.has(turnId)) throw new Error("The conversation turn already owns an active generation.");
    const controller = new AbortController();
    const entry: ActiveTurn = { controller, removeSignalListeners: [] };
    this.#turns.set(turnId, entry);

    for (const signal of upstreamSignals) {
      const onAbort = () => {
        if (!controller.signal.aborted) controller.abort(signal.reason ?? cancellationReason());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      entry.removeSignalListeners.push(() => signal.removeEventListener("abort", onAbort));
      if (signal.aborted) onAbort();
    }

    let released = false;
    return {
      signal: controller.signal,
      release: () => {
        if (released) return;
        released = true;
        for (const remove of entry.removeSignalListeners) remove();
        if (this.#turns.get(turnId) === entry) this.#turns.delete(turnId);
      },
    };
  }

  abort(turnId: string, reason: unknown = cancellationReason()) {
    const entry = this.#turns.get(turnId);
    if (!entry) return false;
    if (!entry.controller.signal.aborted) entry.controller.abort(reason);
    return true;
  }

  has(turnId: string) {
    return this.#turns.has(turnId);
  }
}

type RangabotTurnGlobal = typeof globalThis & {
  __rangabotActiveConversationTurns?: ActiveConversationTurnRegistry;
};

// Chat and cancellation handlers may live in separate server bundles. The
// process-global registry gives Stop one authoritative in-flight owner.
const turnGlobal = globalThis as RangabotTurnGlobal;
const activeConversationTurns = turnGlobal.__rangabotActiveConversationTurns
  ?? new ActiveConversationTurnRegistry();
turnGlobal.__rangabotActiveConversationTurns = activeConversationTurns;

export function registerActiveConversationTurn(turnId: string, upstreamSignals?: AbortSignal[]) {
  return activeConversationTurns.register(turnId, upstreamSignals);
}

export function abortActiveConversationTurn(turnId: string, reason?: unknown) {
  return activeConversationTurns.abort(turnId, reason);
}
