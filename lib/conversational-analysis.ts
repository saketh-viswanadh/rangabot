import type { ChatMessage } from "./providers/types.ts";
import type { SqlExecutionResult } from "./sql-runtime.ts";
import type { SqlProposal } from "./sql-proposals.ts";

const strongAnalysisIntent = /\b(?:calculate|compute|count|total|sum|average|mean|median|minimum|maximum|percent|percentage|rate|ratio|trend|growth|decline|increase|decrease|correlation|distribution|variance|standard deviation|outlier|anomal(?:y|ies)|rank|top|bottom|highest|lowest|group(?:ed|ing)?|segment(?:ed|ation)?|breakdown|forecast|predict|statistic(?:al|ally|s)?|significant|visuali[sz]e|chart|plot)\b/i;
const conditionalAnalysisIntent = /\b(?:analy[sz]e|analysis|compare|comparison|describe|explain|filter|inspect|overview|query|show|summari[sz]e|tell|use|list)\b/i;
const datasetReference = /\b(?:attached|dataset|data set|database|table|file|csv|parquet|duckdb|rows?|records?|columns?|fields?)\b|\b(?:attached|local|my|selected|the|this) data\b/i;
const implicitMetricQuestion = /\bhow many\b|\bwhat (?:is|was|were|are)\b.{0,80}\b(?:total|average|mean|minimum|maximum|rate|ratio|percentage|value|count)\b/i;
const ambiguousMetricQuestion = /\b(?:which|what)\b.{0,60}\b(?:best|most valuable|highest-performing|lowest-performing)\b/i;
const analyticalBoundaryQuestion = /\b(?:why did|what caused|is this (?:healthy|good|bad)|should (?:we|i))\b/i;
const contextualAnalysisFollowUp = /^(?:and|also|but|so|then|what about|how about|why|which|show|compare|break it|drill|filter|only|now)\b/i;
const attachedDataExploration = /\b(?:what (?:can you|do you) (?:find|notice|see)|what(?:'s| is) (?:in|inside) (?:it|this)|tell me (?:a little )?(?:about|what is in) (?:the |this |selected )?data|give me an? (?:overview|summary) of (?:the |this |selected )?data)\b/i;

export function shouldRunSqlAnalysis(messages: ChatMessage[]) {
  const latest = [...messages].reverse().find((message) => message.role === "user")?.content.trim() ?? "";
  if (!latest) return false;
  if (strongAnalysisIntent.test(latest)) return true;
  if (implicitMetricQuestion.test(latest)) return true;
  if (ambiguousMetricQuestion.test(latest)) return true;
  if (analyticalBoundaryQuestion.test(latest)) return true;
  if (conditionalAnalysisIntent.test(latest) && datasetReference.test(latest)) return true;
  if (attachedDataExploration.test(latest)) return true;
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
    { role: "system", content: "You are Rangabot explaining a verified local calculation. Answer directly and naturally. Use only returned labels, column names, and direct values. Every stated number must appear exactly in the supplied result evidence; never calculate, estimate, round, extrapolate, or invent another number. Do not add qualitative judgments. State highest, lowest, or comparisons only when they are directly provable from all supplied rows. Never state or imply a cause. Keep each factual claim in its own short sentence. If evidence is incomplete or truncated, say so. Do not mention SQL unless it explains a material limitation. Return concise Markdown." },
    { role: "user", content: `USER QUESTION:\n${question}\n\nCALCULATION PURPOSE:\n${proposal.explanation}\n\nVERIFIED RESULT EVIDENCE:\n${JSON.stringify(boundedEvidence(result))}\n\nExplain only what this evidence establishes. Lead with the answer, then give useful supporting observations and any material limitation.` },
  ];
}

function numericClaims(value: string) {
  return value.match(/(?<![\p{L}\p{N}_])-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?(?![\p{L}\p{N}_])/gu)?.map((token) => token.replaceAll(",", "")) ?? [];
}

export type AnalysisGroundingFailure =
  | "answer-limit"
  | "empty"
  | "false-limitation"
  | "misbound-value"
  | "unsupported-causation"
  | "unsupported-language"
  | "unsupported-number"
  | "unsupported-ranking";

export type AnalysisGroundingAudit = { grounded: boolean; failures: AnalysisGroundingFailure[] };
export type AnalysisGroundingContext = { query?: string };

const neutralNarrationWords = new Set(`
  a about above across after against all also an and answer are as at average based be because been before below between both bounded but by
  calculation calculations calculated can cannot cause causation compared comparison complete condition conditions count data dataset determine did
  directly display does each equal establish establishes evidence exactly fewer first for found from given has have here higher highest how however in incomplete
  indicates into is it its keep known larger largest last less local lower lowest matching maximum mean metric minimum more most no none not observation
  observations of only or other over partial per percent percentage ratio record records requested result results returned row rows same second show shown
  shows smaller smallest so sole sum table than that the their them there these they this those through to total trails truncated unique value values
  verified was were what when where which while with without
`.match(/[a-z]+/g) ?? []);
const rankingHigh = /\b(?:highest|largest|maximum|top|leads?|more than|higher than|above|exceeds?)\b/i;
const rankingLow = /\b(?:lowest|smallest|minimum|bottom|trails?|less than|lower than|below)\b/i;
const comparative = /\b(?:more than|higher than|above|exceeds?|less than|lower than|below|trails?)\b/i;
const causalLanguage = /\b(?:because|due to|caused by|causes?|led to|driven by|resulted from|responsible for|attributable to|explains? why)\b/i;
const causalDisclaimer = /\b(?:does not|do not|cannot|can't|is not|isn't)\b.{0,50}\b(?:cause|causation|determine why|explain why|establish causation)\b|\bcorrelation does not imply causation\b/i;

function normalized(value: unknown) {
  return String(value).normalize("NFKC").trim().toLowerCase();
}

function wordTokens(value: string) {
  return value.normalize("NFKC").toLowerCase().match(/[\p{L}_][\p{L}\p{N}_-]*/gu)?.flatMap((token) => token.split(/[_-]+/)).filter(Boolean) ?? [];
}

function trustedToken(vocabulary: Set<string>, token: string) {
  if (token.length <= 2 || neutralNarrationWords.has(token) || vocabulary.has(token)) return true;
  if (token.endsWith("s") && vocabulary.has(token.slice(0, -1))) return true;
  if (token.endsWith("es") && vocabulary.has(token.slice(0, -2))) return true;
  return false;
}

function numericValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value.trim())) return Number(value);
  return null;
}

function phrasePosition(text: string, phrase: string) {
  if (!phrase || phrase.length < 2) return -1;
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.search(new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "u"));
}

function queryEstablishesSingleExtremum(query: string | undefined) {
  return Boolean(query && /\border\s+by\b/i.test(query) && /\blimit\s+1\b/i.test(query));
}

function splitClaims(answer: string) {
  return answer
    .replace(/\s+\b(?:and|while|whereas)\b\s+/gi, ".")
    .split(/[.!?;\n]+/)
    .map((claim) => claim.trim())
    .filter(Boolean);
}

export function auditAnalysisNarration(answer: string, result: SqlExecutionResult, context: AnalysisGroundingContext = {}): AnalysisGroundingAudit {
  const failures = new Set<AnalysisGroundingFailure>();
  const trimmed = answer.trim();
  if (!trimmed) failures.add("empty");
  if (trimmed.length > 4_000) failures.add("answer-limit");
  const claims = splitClaims(trimmed);
  if (claims.length > 32) failures.add("answer-limit");

  const evidence = boundedEvidence(result);
  const visibleRows = result.rows.slice(0, 50);
  const visibleColumns = result.columns.slice(0, 40);
  const evidenceNumbers = new Set(numericClaims(JSON.stringify({ columns: evidence.columns, rows: evidence.rows })));
  for (const claim of numericClaims(trimmed)) {
    const escaped = claim.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rowMetadata = Number(claim.replace("%", "")) === result.receipt.returnedRows
      && new RegExp(`(?:\\b${escaped}\\b.{0,24}\\brows?\\b|\\brows?\\b.{0,24}\\b${escaped}\\b)`, "i").test(trimmed);
    if (!evidenceNumbers.has(claim) && !rowMetadata) failures.add("unsupported-number");
  }
  if (!result.receipt.truncated && result.rows.length <= 50
    && /\b(?:truncat(?:ed|ion)|partial result|incomplete result|runtime (?:stopped|limited)|row limit)\b/i.test(trimmed)) failures.add("false-limitation");

  const vocabulary = new Set<string>();
  for (const token of wordTokens(`${visibleColumns.join(" ")} ${context.query ?? ""}`)) vocabulary.add(token);
  const stringCells: Array<{ text: string; row: number; column: number }> = [];
  for (let row = 0; row < visibleRows.length; row += 1) {
    for (let column = 0; column < Math.min(visibleRows[row].length, 40); column += 1) {
      const value = visibleRows[row][column];
      if (typeof value !== "string" || numericValue(value) !== null) continue;
      const text = normalized(value).slice(0, 300);
      if (!text) continue;
      stringCells.push({ text, row, column });
      for (const token of wordTokens(text)) vocabulary.add(token);
    }
  }
  for (const token of wordTokens(trimmed)) if (!trustedToken(vocabulary, token)) failures.add("unsupported-language");

  const numericColumns = visibleColumns.map((_, column) => column).filter((column) => visibleRows.length > 0
    && visibleRows.every((row) => row[column] === null || numericValue(row[column]) !== null));

  for (const clause of claims) {
    if (causalLanguage.test(clause) && !causalDisclaimer.test(clause)) failures.add("unsupported-causation");
    const normalizedClause = normalized(clause);
    const mentioned = [...new Set(stringCells.map((cell) => cell.text))]
      .map((text) => ({ text, cells: stringCells.filter((cell) => cell.text === text), position: phrasePosition(normalizedClause, text) }))
      .filter((cell) => cell.position >= 0);
    const rowsContainingEveryMention = visibleRows
      .map((_, row) => row)
      .filter((row) => mentioned.every((phrase) => phrase.cells.some((cell) => cell.row === row)));
    const high = rankingHigh.test(clause);
    const low = rankingLow.test(clause);
    const comparison = comparative.test(clause);

    if (high || low) {
      if (result.receipt.truncated || result.rows.length > visibleRows.length || mentioned.length === 0) {
        failures.add("unsupported-ranking");
      } else {
        const namedMetricColumns = numericColumns.filter((column) => wordTokens(visibleColumns[column]).some((token) => normalizedClause.includes(token)));
        const metricColumns = namedMetricColumns.length ? namedMetricColumns : numericColumns;
        if (metricColumns.length !== 1) failures.add("unsupported-ranking");
        else if (comparison) {
          const orderedMentions = [...mentioned].sort((left, right) => left.position - right.position);
          const rows = orderedMentions.map((phrase) => [...new Set(phrase.cells.map((cell) => cell.row))]);
          if (rows.length !== 2 || rows.some((matches) => matches.length !== 1)) failures.add("unsupported-ranking");
          else {
            const left = numericValue(visibleRows[rows[0][0]][metricColumns[0]]);
            const right = numericValue(visibleRows[rows[1][0]][metricColumns[0]]);
            const expectsHigher = /\b(?:more than|higher than|above|exceeds?)\b/i.test(clause);
            if (left === null || right === null || (expectsHigher ? left <= right : left >= right)) failures.add("unsupported-ranking");
          }
        } else {
          const values = visibleRows.map((row) => numericValue(row[metricColumns[0]])).filter((value): value is number => value !== null);
          if (!values.length || values.length === 1 && !queryEstablishesSingleExtremum(context.query)) failures.add("unsupported-ranking");
          else {
            const target = high ? Math.max(...values) : Math.min(...values);
            if (rowsContainingEveryMention.length !== 1 || numericValue(visibleRows[rowsContainingEveryMention[0]][metricColumns[0]]) !== target) failures.add("unsupported-ranking");
            if (/\b(?:only|sole|unique)\b/i.test(clause) && values.filter((value) => value === target).length !== 1) failures.add("unsupported-ranking");
          }
        }
      }
    }

    if (!comparison && mentioned.length > 1 && rowsContainingEveryMention.length === 0) failures.add("misbound-value");

    const claimNumbers = [...clause.matchAll(/(?<![\p{L}\p{N}_])-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?(?![\p{L}\p{N}_])/gu)];
    if (mentioned.length && claimNumbers.length) {
      for (const match of claimNumbers) {
        const value = Number(match[0].replaceAll(",", "").replace("%", ""));
        if (value === result.receipt.returnedRows && /\brows?\b/i.test(clause)) continue;
        const nearest = mentioned.reduce((best, phrase) => Math.abs(phrase.position - (match.index ?? 0)) < Math.abs(best.position - (match.index ?? 0)) ? phrase : best);
        if (!nearest.cells.some((entry) => visibleRows[entry.row].some((cell) => numericValue(cell) === value))) failures.add("misbound-value");
      }
    }
  }

  return { grounded: failures.size === 0, failures: [...failures] };
}

export function analysisNarrationIsGrounded(answer: string, result: SqlExecutionResult, context: AnalysisGroundingContext = {}) {
  return auditAnalysisNarration(answer, result, context).grounded;
}

function markdownCell(value: unknown) {
  const text = value === null ? "null" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return text.replaceAll("|", "\\|").replaceAll("\n", " ").slice(0, 300);
}

export function formatVerifiedAnalysisFallback(result: SqlExecutionResult) {
  if (!result.rows.length) return "The verified local calculation returned no rows. That means the requested conditions found no matching result; it does not prove that the underlying phenomenon is absent.";
  const shown = result.rows.slice(0, 20);
  if (shown.length === 1 && result.columns.length === 1) {
    const label = result.columns[0].replaceAll("_", " ").replace(/\s+/g, " ").trim();
    return `The verified ${label || "result"} is **${markdownCell(shown[0][0])}**.`;
  }
  const table = [`| ${result.columns.map(markdownCell).join(" | ")} |`, `| ${result.columns.map(() => "---").join(" | ")} |`, ...shown.map((row) => `| ${row.map(markdownCell).join(" | ")} |`)].join("\n");
  const limitation = result.receipt.truncated || result.rows.length > shown.length ? "\n\nThis display is bounded, so treat it as a partial result rather than the complete dataset." : "";
  return `Here are the verified local results:\n\n${table}${limitation}`;
}
