import assert from "node:assert/strict";
import test from "node:test";
import { ProfileOperationCoordinator, withProfileOperation } from "../lib/profile-operations.ts";

const binding = { profileId: "3d594650-3436-4d7a-914d-ea71dc43cd99", generation: 4 } as const;

test("tracks exact profile-bound operations until their idempotent release", () => {
  const coordinator = new ProfileOperationCoordinator();
  const handle = coordinator.begin({ binding, kind: "generation", label: "Answering locally", cancellable: true });
  assert.deepEqual(coordinator.list().map(({ profileId, generation, kind, label, cancellable }) => ({ profileId, generation, kind, label, cancellable })), [{
    ...binding,
    kind: "generation",
    label: "Answering locally",
    cancellable: true,
  }]);
  assert.equal(handle.cancel(), true);
  assert.equal(handle.signal.aborted, true);
  assert.equal(handle.cancel(), false);
  handle.release();
  handle.release();
  assert.deepEqual(coordinator.list(), []);
});

test("never advertises cancellation for work that cannot stop safely", () => {
  const coordinator = new ProfileOperationCoordinator();
  const handle = coordinator.begin({ binding, kind: "database-mutation", label: "Saving a memory" });
  assert.equal(handle.cancel(), false);
  assert.equal(coordinator.cancel(handle.operation.id), false);
  assert.equal(handle.signal.aborted, false);
  handle.release();
});

test("rejects unsafe labels and bindings", () => {
  const coordinator = new ProfileOperationCoordinator();
  assert.throws(() => coordinator.begin({ binding, kind: "import", label: "\u0000bad" }));
  assert.throws(() => coordinator.begin({ binding: { profileId: "../other", generation: 0 }, kind: "import", label: "Import" }));
  assert.throws(() => coordinator.begin({ binding: { profileId: binding.profileId, generation: -1 }, kind: "import", label: "Import" }));
});

test("withProfileOperation releases ownership after success and failure", async () => {
  const marker = await withProfileOperation({ binding: { profileId: "legacy", generation: 0 }, kind: "export", label: "Export" }, async (handle) => {
    assert.equal(handle.operation.profileId, "legacy");
    return "done";
  });
  assert.equal(marker, "done");
});
