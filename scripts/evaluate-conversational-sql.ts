import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { conversationalSqlCases, type ConversationalSqlCase } from "./conversational-sql-fixtures.ts";
import type { ApprovedDataset } from "../lib/datasets.ts";
import type { ChatMessage } from "../lib/providers/types.ts";
import { completeJsonWithOllama, completeTextWithOllama } from "../lib/providers/ollama.ts";
import { inspectDatasetSchema, executeReadOnlySql, type SqlExecutionResult } from "../lib/sql-runtime.ts";
import { buildSqlProposalMessages, parseSqlProposal, sqlProposalSchema } from "../lib/sql-proposals.ts";
import { analysisNarrationIsGrounded, buildAnalysisNarrationMessages, formatVerifiedAnalysisFallback, shouldRunSqlAnalysis } from "../lib/conversational-analysis.ts";
import { buildConversationMessages } from "../lib/conversation-orchestration.ts";

type Evaluation = {
  id: string;
  difficulty: ConversationalSqlCase["difficulty"];
  context: ConversationalSqlCase["context"];
  expectation: ConversationalSqlCase["expectation"];
  question: string;
  expectedAnswer: string;
  rangabotAnswer: string;
  sql: string | null;
  resultCorrect: boolean | null;
  interpretationCorrect: boolean;
  passed: boolean;
  latencyMs: number;
  error?: string;
};

const resultsDirectory = resolve("data/evaluations/results");
const databasePath = resolve(resultsDirectory, "rangabot-multitable-benchmark.duckdb");
const checkpointPath = resolve(resultsDirectory, "conversational-sql-checkpoint.json");
mkdirSync(resultsDirectory, { recursive: true });

async function createDatabase() {
  if (existsSync(databasePath)) rmSync(databasePath);
  const instance = await DuckDBInstance.create(databasePath);
  const connection = await instance.connect();
  try {
    await connection.run(`
      CREATE TABLE customers AS
      SELECT i::INTEGER AS customer_id,
        (DATE '2024-01-01' + ((i * 11) % 365)::INTEGER) AS signup_date,
        CASE i % 4 WHEN 0 THEN 'North' WHEN 1 THEN 'South' WHEN 2 THEN 'East' ELSE 'West' END AS region,
        CASE i % 3 WHEN 0 THEN 'Enterprise' WHEN 1 THEN 'SMB' ELSE 'Consumer' END AS segment,
        CASE i % 4 WHEN 0 THEN 'Organic' WHEN 1 THEN 'Search' WHEN 2 THEN 'Social' ELSE 'Partner' END AS acquisition_channel,
        (i % 9 <> 0) AS is_active
      FROM range(1, 241) t(i);

      CREATE TABLE products AS
      SELECT i::INTEGER AS product_id,
        CASE i % 6 WHEN 0 THEN 'Electronics' WHEN 1 THEN 'Home' WHEN 2 THEN 'Books' WHEN 3 THEN 'Fitness' WHEN 4 THEN 'Beauty' ELSE 'Office' END AS category,
        'Product ' || lpad(i::VARCHAR, 2, '0') AS product_name,
        round((8 + (i % 7) * 3.25)::DOUBLE, 2) AS unit_cost,
        round((18 + (i % 9) * 6.5)::DOUBLE, 2) AS list_price
      FROM range(1, 37) t(i);

      CREATE TABLE campaigns AS
      SELECT i::INTEGER AS campaign_id,
        CASE i % 4 WHEN 0 THEN 'Search' WHEN 1 THEN 'Social' WHEN 2 THEN 'Email' ELSE 'Partner' END AS channel,
        (DATE '2025-01-01' + ((i - 1) * 28)::INTEGER) AS start_date,
        (DATE '2025-01-01' + ((i - 1) * 28 + 55)::INTEGER) AS end_date,
        (700 + i * 175)::DOUBLE AS spend
      FROM range(1, 13) t(i);

      CREATE TABLE orders AS
      SELECT i::INTEGER AS order_id,
        (((i * 17) % 240) + 1)::INTEGER AS customer_id,
        (DATE '2025-01-01' + ((i * 7 + floor(i / 11)) % 365)::INTEGER) AS order_date,
        CASE WHEN i % 20 = 0 THEN 'cancelled' WHEN i % 17 = 0 THEN 'refunded' ELSE 'completed' END AS status,
        CASE WHEN i % 3 = 0 THEN NULL ELSE ((i % 12) + 1)::INTEGER END AS campaign_id
      FROM range(1, 1201) t(i);

      CREATE TABLE order_items AS
      SELECT row_number() OVER ()::INTEGER AS order_item_id,
        o.order_id,
        (((o.order_id * 5 + n * 7) % 36) + 1)::INTEGER AS product_id,
        ((o.order_id + n) % 4 + 1)::INTEGER AS quantity,
        p.list_price AS unit_price,
        CASE (o.order_id + n) % 5 WHEN 0 THEN 0.20 WHEN 1 THEN 0.10 ELSE 0.00 END::DOUBLE AS discount_pct
      FROM orders o
      CROSS JOIN range(1, 4) x(n)
      JOIN products p ON p.product_id = (((o.order_id * 5 + n * 7) % 36) + 1)
      WHERE n <= 1 + (o.order_id % 3);

      CREATE TABLE payments AS
      SELECT row_number() OVER ()::INTEGER AS payment_id,
        o.order_id,
        o.order_date + ((o.order_id % 4) + 1)::INTEGER AS payment_date,
        CASE o.order_id % 4 WHEN 0 THEN 'card' WHEN 1 THEN 'wallet' WHEN 2 THEN 'bank_transfer' ELSE 'cash' END AS payment_method,
        round(sum(oi.quantity * oi.unit_price * (1 - oi.discount_pct)), 2) AS amount,
        CASE WHEN o.status = 'refunded' THEN 'refunded' ELSE 'paid' END AS payment_status
      FROM orders o JOIN order_items oi USING (order_id)
      WHERE o.status <> 'cancelled'
      GROUP BY o.order_id, o.order_date, o.status;

      CREATE TABLE support_tickets AS
      SELECT i::INTEGER AS ticket_id,
        (((i * 19) % 240) + 1)::INTEGER AS customer_id,
        TIMESTAMP '2025-01-01 09:00:00' + ((i * 29) % 8500) * INTERVAL '1 hour' AS created_at,
        CASE WHEN i % 10 = 0 THEN NULL ELSE TIMESTAMP '2025-01-01 09:00:00' + (((i * 29) % 8500) + 2 + (i % 72)) * INTERVAL '1 hour' END AS resolved_at,
        CASE i % 3 WHEN 0 THEN 'high' WHEN 1 THEN 'medium' ELSE 'low' END AS priority,
        CASE WHEN i % 10 = 0 THEN NULL ELSE (1 + i % 5)::INTEGER END AS satisfaction_score
      FROM range(1, 301) t(i);

      CREATE TABLE returns AS
      SELECT row_number() OVER ()::INTEGER AS return_id,
        oi.order_item_id,
        (1 + oi.order_item_id % greatest(oi.quantity, 1))::INTEGER AS return_quantity,
        CASE oi.order_item_id % 4 WHEN 0 THEN 'damaged' WHEN 1 THEN 'fit' WHEN 2 THEN 'changed_mind' ELSE 'late_delivery' END AS return_reason,
        o.order_date + (7 + oi.order_item_id % 21)::INTEGER AS return_date
      FROM order_items oi JOIN orders o USING (order_id)
      WHERE oi.order_item_id % 13 = 0 AND o.status <> 'cancelled';
    `);
  } finally {
    connection.closeSync(); instance.closeSync();
  }
}

function cell(value: unknown) {
  if (value === null) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function resultTable(result: SqlExecutionResult) {
  if (!result.rows.length) return "The correct query returns no rows.";
  return [`| ${result.columns.join(" | ")} |`, `| ${result.columns.map(() => "---").join(" | ")} |`, ...result.rows.map((row) => `| ${row.map(cell).join(" | ")} |`)].join("\n");
}

function comparable(value: unknown): { kind: "number"; value: number } | { kind: "text"; value: string } {
  const text = cell(value).trim().toLowerCase();
  const number = Number(text.replace(/[%,$]/g, ""));
  return Number.isFinite(number) && text !== "" ? { kind: "number", value: number } : { kind: "text", value: text };
}

function valuesMatch(left: unknown, right: unknown) {
  const a = comparable(left); const b = comparable(right);
  if (a.kind === "number" && b.kind === "number") return Math.abs(a.value - b.value) <= Math.max(0.02, Math.abs(a.value) * 0.0001);
  return a.kind === "text" && b.kind === "text" && a.value === b.value;
}

function resultContainsGold(candidate: SqlExecutionResult, gold: SqlExecutionResult) {
  if (candidate.rows.length !== gold.rows.length) return false;
  return gold.rows.every((goldRow) => candidate.rows.some((candidateRow) => goldRow.every((goldValue) => candidateRow.some((candidateValue) => valuesMatch(goldValue, candidateValue)))));
}

const semanticStopWords = new Set(["a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is", "it", "of", "or", "so", "the", "this", "to"]);
function semanticTokens(value: string) {
  return new Set(value.toLowerCase().match(/[a-z0-9]+/g)?.filter((token) => token.length > 2 && !semanticStopWords.has(token)) ?? []);
}

function boundaryAnswerCorrect(testCase: ConversationalSqlCase, answer: string) {
  const expected = semanticTokens(testCase.expectedAnswer ?? "");
  const actual = semanticTokens(answer);
  const overlap = [...expected].filter((token) => actual.has(token)).length / Math.max(1, expected.size);
  if (testCase.expectation === "clarify") return overlap >= 0.2 && (answer.includes("?") || /\b(?:clarify|define|mean|which|what|need)\b/i.test(answer));
  return overlap >= 0.2 && /\b(?:cannot|can't|do not|don't|missing|absent|requires?|insufficient|not present|no .+ data)\b/i.test(answer);
}

async function runCase(testCase: ConversationalSqlCase, dataset: ApprovedDataset, schema: Awaited<ReturnType<typeof inspectDatasetSchema>>): Promise<Evaluation> {
  const started = Date.now();
  const messages: ChatMessage[] = [{ role: "user", content: testCase.question }];
  let sql: string | null = null;
  let candidateResult: SqlExecutionResult | null = null;
  try {
    let answer: string;
    if (shouldRunSqlAnalysis(messages)) {
      const raw = await completeJsonWithOllama(buildSqlProposalMessages(messages, dataset, schema), { jsonSchema: sqlProposalSchema, numPredict: 700, timeoutMs: 180_000 });
      const proposal = parseSqlProposal(raw);
      if (proposal.action !== "query") {
        answer = proposal.explanation;
        const interpretationCorrect = testCase.expectation !== "execute" && boundaryAnswerCorrect(testCase, answer);
        return { id: testCase.id, difficulty: testCase.difficulty, context: testCase.context, expectation: testCase.expectation, question: testCase.question, expectedAnswer: testCase.expectedAnswer ?? "", rangabotAnswer: answer, sql: null, resultCorrect: testCase.expectation === "execute" ? false : null, interpretationCorrect, passed: interpretationCorrect, latencyMs: Date.now() - started };
      }
      sql = proposal.query;
      candidateResult = await executeReadOnlySql({ approvedDatasetPath: databasePath, query: sql });
      const narrated = await completeTextWithOllama(buildAnalysisNarrationMessages(testCase.question, proposal, candidateResult), { numPredict: 700, timeoutMs: 180_000 });
      answer = analysisNarrationIsGrounded(narrated, candidateResult) ? narrated : formatVerifiedAnalysisFallback(candidateResult);
    } else {
      answer = await completeTextWithOllama(buildConversationMessages(messages).messages, { numPredict: 500, timeoutMs: 180_000 });
    }

    if (testCase.expectation !== "execute") {
      const interpretationCorrect = boundaryAnswerCorrect(testCase, answer);
      return { id: testCase.id, difficulty: testCase.difficulty, context: testCase.context, expectation: testCase.expectation, question: testCase.question, expectedAnswer: testCase.expectedAnswer ?? "", rangabotAnswer: answer, sql, resultCorrect: null, interpretationCorrect, passed: interpretationCorrect, latencyMs: Date.now() - started };
    }

    if (!testCase.goldSql) throw new Error("Executable fixture has no gold SQL.");
    const gold = await executeReadOnlySql({ approvedDatasetPath: databasePath, query: testCase.goldSql });
    const resultCorrect = Boolean(candidateResult && resultContainsGold(candidateResult, gold));
    const interpretationCorrect = Boolean(candidateResult && resultCorrect && analysisNarrationIsGrounded(answer, candidateResult) && answer.trim());
    return { id: testCase.id, difficulty: testCase.difficulty, context: testCase.context, expectation: testCase.expectation, question: testCase.question, expectedAnswer: resultTable(gold), rangabotAnswer: answer, sql, resultCorrect, interpretationCorrect, passed: resultCorrect && interpretationCorrect, latencyMs: Date.now() - started };
  } catch (error) {
    let expectedAnswer = testCase.expectedAnswer ?? "";
    if (testCase.goldSql) {
      try { expectedAnswer = resultTable(await executeReadOnlySql({ approvedDatasetPath: databasePath, query: testCase.goldSql })); } catch { /* retain empty expectation */ }
    }
    return { id: testCase.id, difficulty: testCase.difficulty, context: testCase.context, expectation: testCase.expectation, question: testCase.question, expectedAnswer, rangabotAnswer: "", sql, resultCorrect: testCase.expectation === "execute" ? false : null, interpretationCorrect: false, passed: false, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
  }
}

function aggregate(results: Evaluation[], key: "difficulty" | "context") {
  return Object.fromEntries([...new Set(results.map((result) => result[key]))].map((value) => {
    const group = results.filter((result) => result[key] === value);
    return [value, { passed: group.filter((result) => result.passed).length, total: group.length, passRate: group.filter((result) => result.passed).length / group.length }];
  }));
}

function markdownReport(results: Evaluation[]) {
  const passed = results.filter((result) => result.passed).length;
  const lines = [
    "# Rangabot multi-table conversational SQL validation",
    "",
    `**Overall:** ${passed}/${results.length} (${(100 * passed / results.length).toFixed(1)}%)`,
    "",
    "This report uses a deterministic synthetic DuckDB database. A pass requires the generated SQL result to match an independently executed gold query and the answer to remain numerically grounded. Clarification and unavailable-context cases must state the appropriate boundary.",
    "",
    "## Summary",
    "",
    `- By difficulty: \`${JSON.stringify(aggregate(results, "difficulty"))}\``,
    `- By context: \`${JSON.stringify(aggregate(results, "context"))}\``,
    "",
    "## Case results",
  ];
  for (const result of results) {
    lines.push("", `### ${result.id} · ${result.difficulty} · ${result.context} context · ${result.passed ? "PASS" : "FAIL"}`, "", "**Question**", "", result.question, "", "**Correct answer**", "", result.expectedAnswer || "No answer could be computed.", "", "**Rangabot answer**", "", result.rangabotAnswer || `Execution error: ${result.error ?? "unknown"}`, "", "**SQL used by Rangabot**", "", result.sql ? `\`\`\`sql\n${result.sql}\n\`\`\`` : "No SQL was used.", "", `**Interpretation correct?** ${result.interpretationCorrect ? "Yes" : "No"}${result.resultCorrect === null ? "" : ` · **SQL result correct?** ${result.resultCorrect ? "Yes" : "No"}`}`);
  }
  return `${lines.join("\n")}\n`;
}

const counts = Object.fromEntries(["easy", "medium", "hard", "extreme"].map((difficulty) => [difficulty, conversationalSqlCases.filter((item) => item.difficulty === difficulty).length]));
if (conversationalSqlCases.length !== 50 || counts.easy !== 10 || counts.medium !== 15 || counts.hard !== 20 || counts.extreme !== 5) throw new Error(`Invalid benchmark distribution: ${JSON.stringify(counts)}`);

await createDatabase();
const dataset: ApprovedDataset = { id: "synthetic-multitable", name: "rangabot-multitable-benchmark.duckdb", path: databasePath, format: "duckdb", sizeBytes: 0, addedAt: new Date().toISOString() };
const schema = await inspectDatasetSchema(databasePath);
if (process.argv.includes("--validate-only")) {
  for (const testCase of conversationalSqlCases) if (testCase.goldSql) await executeReadOnlySql({ approvedDatasetPath: databasePath, query: testCase.goldSql });
  console.log(`PASS: validated ${conversationalSqlCases.length} cases, ${conversationalSqlCases.filter((item) => item.goldSql).length} gold queries, and ${new Set(schema.map((column) => column.table)).size} tables.`);
  process.exit(0);
}
const prior: Evaluation[] = process.argv.includes("--resume") && existsSync(checkpointPath) ? JSON.parse(readFileSync(checkpointPath, "utf8")) as Evaluation[] : [];
const results = [...prior];
console.log(`Running ${conversationalSqlCases.length} conversational SQL cases against ${new Set(schema.map((column) => column.table)).size} tables.`);
for (const testCase of conversationalSqlCases) {
  if (results.some((result) => result.id === testCase.id)) { console.log(`SKIP ${testCase.id} (checkpointed)`); continue; }
  const result = await runCase(testCase, dataset, schema);
  results.push(result);
  writeFileSync(checkpointPath, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`${result.passed ? "PASS" : "FAIL"} ${testCase.id} ${testCase.difficulty}/${testCase.context} (${(result.latencyMs / 1000).toFixed(1)}s)${result.error ? `: ${result.error}` : ""}`);
}
const outputJson = resolve(resultsDirectory, `conversational-sql-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
const outputMarkdown = outputJson.replace(/\.json$/, ".md");
const summary = { suite: { name: "rangabot-conversational-sql", version: "1.0.0" }, database: { synthetic: true, tables: new Set(schema.map((column) => column.table)).size, columns: schema.length }, total: results.length, passed: results.filter((result) => result.passed).length, byDifficulty: aggregate(results, "difficulty"), byContext: aggregate(results, "context"), results };
writeFileSync(outputJson, `${JSON.stringify(summary, null, 2)}\n`);
writeFileSync(outputMarkdown, markdownReport(results));
console.log(`\nPass rate: ${summary.passed}/${summary.total} (${(100 * summary.passed / summary.total).toFixed(1)}%)`);
console.log(`Private JSON: ${outputJson}`);
console.log(`Private report: ${outputMarkdown}`);
