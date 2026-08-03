import type { ChatMessage } from "./providers/types.ts";
import type { SqlExecutionResult } from "./sql-runtime.ts";
import type { SqlProposal } from "./sql-proposals.ts";

const strongAnalysisIntent = /\b(?:calculate|compute|count|total|sum|average|mean|median|minimum|maximum|percent|percentage|rate|ratio|trend|growth|decline|increase|decrease|correlation|distribution|variance|standard deviation|outlier|anomal(?:y|ies)|rank|top|bottom|highest|lowest|group(?:ed|ing)?|segment(?:ed|ation)?|breakdown|forecast|predict|statistic(?:al|ally|s)?|significant|visuali[sz]e|chart|plot)\b/i;
const conditionalAnalysisIntent = /\b(?:analy[sz]e|analysis|compare|comparison|filter|query|summari[sz]e|show|list|inspect)\b/i;
const datasetReference = /\b(?:attached|dataset|data set|database|table|file|csv|parquet|duckdb|rows?|records?|columns?|fields?|customers?|products?|orders?|payments?|tickets?|campaigns?|revenue|sales)\b/i;
const implicitMetricQuestion = /\bhow many\b|\bwhat (?:is|was|were|are)\b.{0,80}\b(?:revenue|sales|orders?|customers?|tickets?|payments?|total|average|rate|margin|value)\b/i;
const contextualAnalysisFollowUp = /^(?:and|also|but|so|then|what about|how about|why|which|show|compare|break it|drill|filter|only|now)\b/i;

export function shouldRunSqlAnalysis(messages: ChatMessage[]) {
  const latest = [...messages].reverse().find((message) => message.role === "user")?.content.trim() ?? "";
  if (!latest) return false;
  if (strongAnalysisIntent.test(latest)) return true;
  if (implicitMetricQuestion.test(latest)) return true;
  if (conditionalAnalysisIntent.test(latest) && datasetReference.test(latest)) return true;
  const hadAnalysis = messages.slice(0, -1).some((message) => message.role === "assistant" && message.analysisTrace?.engine === "duckdb");
  return hadAnalysis && contextualAnalysisFollowUp.test(latest);
}

function boundedEvidence(result: SqlExecutionResult, maxRows = 50) {
  return {
    columns: result.columns,
    rows: result.rows.slice(0, maxRows).map((row) => row.map((value) => {
      const text = value === null ? null : typeof value === "object" ? JSON.stringify(value) : String(value);
      return typeof text === "string" && text.length > 300 ? `${text.slice(0, 297)}…` : text;
    })),
    returnedRows: result.receipt.returnedRows,
    evidenceRows: Math.min(result.rows.length, maxRows),
    omittedFromNarration: Math.max(0, result.rows.length - maxRows),
    truncatedByRuntime: result.receipt.truncated,
  };
}

export function buildAnalysisNarrationMessages(question: string, proposal: SqlProposal, result: SqlExecutionResult): ChatMessage[] {
  return [
    { role: "system", content: "You are Rangabot explaining a verified local calculation. Answer directly and naturally. Every stated number must appear exactly in the supplied result evidence; never calculate, estimate, round, extrapolate, or invent another number. Distinguish observation from interpretation. If evidence is incomplete or truncated, say so. Do not mention SQL unless it explains a material limitation. Do not claim causation from association. Return concise Markdown." },
    { role: "user", content: `USER QUESTION:\n${question}\n\nCALCULATION PURPOSE:\n${proposal.explanation}\n\nVERIFIED RESULT EVIDENCE:\n${JSON.stringify(boundedEvidence(result))}\n\nExplain only what this evidence establishes. Lead with the answer, then give useful supporting observations and any material limitation.` },
  ];
}

function numericClaims(value: string) {
  return value.match(/(?<![\p{L}\p{N}_])-?\d[\d,]*(?:\.\d+)?%?(?![\p{L}\p{N}_])/gu)?.map((token) => token.replaceAll(",", "")) ?? [];
}

export function analysisNarrationIsGrounded(answer: string, result: SqlExecutionResult) {
  if (!answer.trim()) return false;
  if (!result.receipt.truncated && result.rows.length <= 50
    && /\b(?:truncat(?:ed|ion)|partial result|incomplete result|runtime (?:stopped|limited)|row limit)\b/i.test(answer)) return false;
  const allowed = new Set(numericClaims(JSON.stringify({ columns: result.columns, rows: result.rows, returnedRows: result.receipt.returnedRows })));
  return numericClaims(answer).every((claim) => allowed.has(claim));
}

function markdownCell(value: unknown) {
  const text = value === null ? "null" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return text.replaceAll("|", "\\|").replaceAll("\n", " ").slice(0, 300);
}

export function formatVerifiedAnalysisFallback(result: SqlExecutionResult) {
  if (!result.rows.length) return "The verified local calculation returned no rows. That means the requested conditions found no matching result; it does not prove that the underlying phenomenon is absent.";
  const shown = result.rows.slice(0, 20);
  const table = [`| ${result.columns.map(markdownCell).join(" | ")} |`, `| ${result.columns.map(() => "---").join(" | ")} |`, ...shown.map((row) => `| ${row.map(markdownCell).join(" | ")} |`)].join("\n");
  const limitation = result.receipt.truncated || result.rows.length > shown.length ? "\n\nThis display is bounded, so treat it as a partial result rather than the complete dataset." : "";
  return `Here are the verified local results:\n\n${table}${limitation}`;
}
