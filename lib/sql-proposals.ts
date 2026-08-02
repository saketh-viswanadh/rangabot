import type { ChatMessage } from "./providers/types.ts";
import type { ApprovedDataset } from "./datasets.ts";
import type { DatasetColumn } from "./sql-runtime.ts";
import { validateSqlPreviewQuery } from "./sql-confirmations.ts";

export type SqlProposal = { query: string; explanation: string };

export const sqlProposalSchema = {
  type: "object",
  additionalProperties: false,
  required: ["query", "explanation"],
  properties: {
    query: { type: "string", minLength: 1, maxLength: 8_000 },
    explanation: { type: "string", minLength: 1, maxLength: 500 },
  },
};

export function parseSqlProposal(raw: string): SqlProposal {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object") throw new Error("The local model returned an invalid SQL proposal.");
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.query !== "string" || candidate.query.length > 8_000 || typeof candidate.explanation !== "string" || !candidate.explanation.trim() || candidate.explanation.length > 500) {
    throw new Error("The local model returned an incomplete SQL proposal.");
  }
  return { query: validateSqlPreviewQuery(candidate.query), explanation: candidate.explanation.trim() };
}

export function buildSqlProposalMessages(messages: ChatMessage[], dataset: ApprovedDataset, columns: DatasetColumn[]): ChatMessage[] {
  const request = [...messages].reverse().find((message) => message.role === "user")?.content.trim() ?? "";
  const schema = columns.map((column) => `- ${JSON.stringify(column.name)}: ${column.type}`).join("\n");
  return [
    { role: "system", content: "You are Rangabot's local SQL planner. Produce one DuckDB SELECT query only through the required JSON schema. The only available relation is dataset. Use only listed columns. Never invent data, results, columns, tables, files, or external access. Do not use ATTACH, COPY, CREATE, DELETE, DROP, EXPORT, INSTALL, LOAD, PRAGMA, SET, UPDATE, INSERT, CALL, ALTER, VACUUM, or multiple statements. If the request cannot be answered from the schema, make the query return zero rows and explain the missing field." },
    { role: "user", content: `USER REQUEST:\n${request}\n\nAPPROVED LOCAL DATASET:\n${dataset.name} (${dataset.format})\n\nSCHEMA:\n${schema}\n\nReturn {"query":"...","explanation":"..."}. The explanation must describe what the query calculates without claiming results.` },
  ];
}
