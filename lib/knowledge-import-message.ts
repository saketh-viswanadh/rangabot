function boundedCount(value: unknown, maximum = 10_000) {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum ? Number(value) : 0;
}

export function knowledgeImportMessage(input: {
  selected: unknown;
  copied: unknown;
  incompatible: unknown;
  pending: unknown;
}) {
  const selected = boundedCount(input.selected, 20);
  const copied = boundedCount(input.copied, 20);
  const incompatible = boundedCount(input.incompatible);
  const pending = boundedCount(input.pending);
  const attention = incompatible + pending;
  const prefix = `Imported ${selected} selection${selected === 1 ? "" : "s"} into Knowledge (${copied} new private cop${copied === 1 ? "y" : "ies"}).`;
  return attention > 0
    ? `${prefix} Knowledge currently reports ${attention} source${attention === 1 ? "" : "s"} needing attention; some may not be searchable.`
    : `${prefix} Local processing finished without a source warning.`;
}

export function knowledgeImportFailureMessage(input: {
  error?: unknown;
  partial?: unknown;
  retained?: unknown;
}) {
  if (typeof input.error === "string" && input.error.trim()) return input.error;
  if (input.partial === true) {
    const retained = Array.isArray(input.retained)
      ? input.retained.filter((item): item is string => typeof item === "string" && item.length > 0).length
      : 0;
    return retained > 0
      ? `${retained} selected document${retained === 1 ? " remains" : "s remain"} in Knowledge, but local processing may not have finished.`
      : "Some selected documents may remain in Knowledge, but local processing did not finish.";
  }
  return "The documents could not be imported.";
}
