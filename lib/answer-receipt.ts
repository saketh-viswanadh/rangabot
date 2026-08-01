export function formatAnswerReceipt(input: {
  knowledgeUsed?: boolean;
  retrievalMode?: "hybrid" | "keyword-only";
  memoryUse?: "context" | "direct";
  memoryTitles?: string[];
}) {
  let receipt = "LOCAL";
  if (input.knowledgeUsed || input.retrievalMode) {
    receipt += " · KNOWLEDGE VAULT";
    if (input.retrievalMode === "hybrid") receipt += " · HYBRID";
    if (input.retrievalMode === "keyword-only") receipt += " · KEYWORD ONLY";
  }
  if (input.memoryUse) {
    receipt += " · MEMORY";
    if (input.memoryUse === "direct") receipt += " · DIRECT RECALL";
    if (input.memoryTitles?.length) receipt += ` · ${input.memoryTitles.join(" · ")}`;
  }
  return receipt;
}
