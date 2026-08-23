import type { AnswerContract } from "./conversation-contract.ts";
import { deriveSemanticTaskFrame } from "./conversation-task-frame.ts";
import type { ChatMessage } from "./providers/types.ts";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

export const FINISH_VERIFICATION_VERSION = "finish-v1" as const;

export type FinishVerificationCheck = "requirements" | "arithmetic" | "code-structure" | "preservation" | "completion";
export type FinishVerificationStatus = "passed" | "repaired" | "warning";
export type FinishVerificationReceipt = {
  version: typeof FINISH_VERIFICATION_VERSION;
  status: FinishVerificationStatus;
  checks: FinishVerificationCheck[];
  issueCount: number;
  manualReview?: "ambiguous-sentence-boundary";
};

export type FinishVerificationIssue = {
  code:
    | "word-count"
    | "sentence-count"
    | "list-count"
    | "forbidden-term"
    | "format"
    | "arithmetic"
    | "missing-code"
    | "code-structure"
    | "preservation"
    | "incomplete";
  message: string;
};

type ArithmeticFact = { expression: string; result: string };

export type FinishVerificationPlan = {
  shouldVerify: boolean;
  checks: FinishVerificationCheck[];
  arithmeticFacts: ArithmeticFact[];
  requiredLiterals: string[];
  codeRequested: boolean;
};

const codeArtifactActionPattern = /\b(?:write|draft|create|generate|fix|debug|rewrite|refactor|implement)\b([\s\S]{0,80}?)\b(?:code|function|class|script|program|query|component)\b/giu;
const codeProseCarrierPattern = /\b(?:explanation|email|documentation|description|memo|guide|article|paragraph|report|lesson|tutorial|study\s+plan|implementation\s+(?:plan|roadmap)|migration\s+(?:plan|roadmap)|plan|roadmap)\b/iu;
const codePlanningCarrierPattern = /\b(?:(?:implementation|migration)\s+(?:plan|roadmap)|(?:plan|roadmap)\s+(?:how|to))\b/iu;
const implementationLanguagePattern = /\bimplement\b[\s\S]{0,80}\b(?:in|using)\s+(?:python|javascript|typescript|java|pyspark|sql)\b/iu;
const arithmeticRequestPattern = /^\s*(?:calculate|compute|work\s+out|what(?:'s|\s+is))\s+([^?!\n]+?)\s*[?.!]?\s*$/iu;
const percentagePattern = /^(\d+(?:\.\d+)?)\s*%\s+of\s+(\d+(?:\.\d+)?)$/iu;
const exactZero = BigInt(0);
const exactOne = BigInt(1);
const exactTwo = BigInt(2);
const exactFive = BigInt(5);
const exactTen = BigInt(10);
const exactHundred = BigInt(100);
const maximumExactMagnitude = BigInt("1000000000000000");
const maximumDecimalPlaces = 8;
type ExactValue = { numerator: bigint; denominator: bigint };
type MarkdownNode = {
  type: string;
  value?: string;
  ordered?: boolean;
  children?: MarkdownNode[];
};

const markdownParser = unified().use(remarkParse).use(remarkGfm);

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

function requestsCodeArtifact(request: string) {
  codeArtifactActionPattern.lastIndex = 0;
  for (const match of request.matchAll(codeArtifactActionPattern)) {
    const suffix = request.slice((match.index ?? 0) + match[0].length);
    if (/\b(?:and|plus|then)\s+(?:an?\s+)?implementation\b(?!\s+(?:plan|roadmap|outline|overview|guide|notes|documentation|description)\b)/iu.test(suffix)) return true;
    if (/^\s+(?:name|signature|definition|purpose|overview|description|documentation|explanation|guide|tutorial|lesson|memo|email|article|report)\b/iu.test(suffix)) continue;
    if (!codeProseCarrierPattern.test(match[1])
      || /\b(?:and|plus|then|with|including|containing|along\s+with|as\s+well\s+as)(?:\s+(?:include|containing))?\s+(?:an?\s+)?(?:example\s+)?(?:(?:python|javascript|typescript|java|pyspark|sql)\s+)?$/iu.test(match[1])) return true;
  }
  return !codePlanningCarrierPattern.test(request) && implementationLanguagePattern.test(request);
}

function absolute(value: bigint) {
  return value < exactZero ? -value : value;
}

function greatestCommonDivisor(left: bigint, right: bigint) {
  let a = absolute(left);
  let b = absolute(right);
  while (b) [a, b] = [b, a % b];
  return a || exactOne;
}

function normalizeExactValue(numerator: bigint, denominator: bigint): ExactValue | null {
  if (!denominator) return null;
  const sign = denominator < exactZero ? -exactOne : exactOne;
  const divisor = greatestCommonDivisor(numerator, denominator);
  return { numerator: numerator / divisor * sign, denominator: absolute(denominator) / divisor };
}

function exactDecimalPlaces(value: ExactValue) {
  let denominator = value.denominator;
  let twos = 0;
  let fives = 0;
  while (denominator % exactTwo === exactZero) { denominator /= exactTwo; twos += 1; }
  while (denominator % exactFive === exactZero) { denominator /= exactFive; fives += 1; }
  return denominator === exactOne ? Math.max(twos, fives) : null;
}

function supportedExactValue(value: ExactValue | null): ExactValue | null {
  if (!value || absolute(value.numerator) > maximumExactMagnitude * value.denominator) return null;
  const places = exactDecimalPlaces(value);
  return places !== null && places <= maximumDecimalPlaces ? value : null;
}

function supportedNumericLiteral(token: string): ExactValue | null {
  const [whole, fraction = ""] = token.split(".");
  const meaningfulFraction = fraction.replace(/0+$/, "");
  if (meaningfulFraction.length > maximumDecimalPlaces) return null;
  const denominator = exactTen ** BigInt(fraction.length);
  const numerator = BigInt(whole) * denominator + BigInt(fraction || "0");
  return supportedExactValue(normalizeExactValue(numerator, denominator));
}

function exactOperation(left: ExactValue, operator: string, right: ExactValue): ExactValue | null {
  if (operator === "/" && right.numerator === exactZero) return null;
  if (operator === "+") return supportedExactValue(normalizeExactValue(left.numerator * right.denominator + right.numerator * left.denominator, left.denominator * right.denominator));
  if (operator === "-") return supportedExactValue(normalizeExactValue(left.numerator * right.denominator - right.numerator * left.denominator, left.denominator * right.denominator));
  if (operator === "*") return supportedExactValue(normalizeExactValue(left.numerator * right.numerator, left.denominator * right.denominator));
  if (operator === "/") return supportedExactValue(normalizeExactValue(left.numerator * right.denominator, left.denominator * right.numerator));
  return null;
}

function canonicalExactValue(value: ExactValue) {
  const places = exactDecimalPlaces(value) ?? 0;
  if (!places) return String(value.numerator);
  const scale = exactTen ** BigInt(places);
  const scaled = value.numerator * (scale / value.denominator);
  const sign = scaled < exactZero ? "-" : "";
  const digits = absolute(scaled).toString().padStart(places + 1, "0");
  const whole = digits.slice(0, -places);
  const fraction = digits.slice(-places).replace(/0+$/, "");
  return fraction ? `${sign}${whole}.${fraction}` : `${sign}${whole}`;
}

function tokenizeArithmetic(source: string): string[] | null {
  if (/\b0x[\da-f]+\b/i.test(source)) return null;
  const normalized = source
    .replace(/[×x]/gi, "*")
    .replace(/[÷]/g, "/")
    .replace(/[−–—]/g, "-")
    .replace(/\bdivided\s+by\b/gi, "/")
    .replace(/\bmultiplied\s+by\b|\btimes\b/gi, "*")
    .replace(/\bplus\b/gi, "+")
    .replace(/\bminus\b/gi, "-")
    .trim();
  if (!normalized || normalized.length > 120 || /[^\d\s()+\-*/.]/.test(normalized)) return null;
  const tokens = normalized.match(/\d+(?:\.\d+)?|[()+\-*/]/g);
  if (!tokens || tokens.join("") !== normalized.replace(/\s+/g, "")) return null;
  return tokens;
}

function evaluateTokens(tokens: string[]): string | null {
  let index = 0;
  const primary = (): ExactValue | null => {
    const token = tokens[index];
    if (token === "+" || token === "-") {
      index += 1;
      const value = primary();
      return value === null || token === "+" ? value : { numerator: -value.numerator, denominator: value.denominator };
    }
    if (token === "(") {
      index += 1;
      const value = expression();
      if (value === null || tokens[index] !== ")") return null;
      index += 1;
      return value;
    }
    if (!token || !/^\d+(?:\.\d+)?$/.test(token)) return null;
    index += 1;
    return supportedNumericLiteral(token);
  };
  const product = (): ExactValue | null => {
    let value = primary();
    if (value === null) return null;
    while (tokens[index] === "*" || tokens[index] === "/") {
      const operator = tokens[index++];
      const right = primary();
      if (right === null) return null;
      const evaluated = exactOperation(value, operator, right);
      if (evaluated === null) return null;
      value = evaluated;
    }
    return value;
  };
  const expression = (): ExactValue | null => {
    let value = product();
    if (value === null) return null;
    while (tokens[index] === "+" || tokens[index] === "-") {
      const operator = tokens[index++];
      const right = product();
      if (right === null) return null;
      const evaluated = exactOperation(value, operator, right);
      if (evaluated === null) return null;
      value = evaluated;
    }
    return value;
  };
  const result = expression();
  return result !== null && index === tokens.length ? canonicalExactValue(result) : null;
}

export function deriveArithmeticFacts(request: string): ArithmeticFact[] {
  if (/[)\d]\s*!\s*[?.]?\s*$/u.test(request)) return [];
  const matched = request.match(arithmeticRequestPattern);
  if (!matched) return [];
  const expression = matched[1].trim();
  const percentage = expression.match(percentagePattern);
  if (percentage) {
    const percent = supportedNumericLiteral(percentage[1]);
    const base = supportedNumericLiteral(percentage[2]);
    if (percent === null || base === null) return [];
    const ratio = exactOperation(percent, "/", { numerator: exactHundred, denominator: exactOne });
    const value = ratio === null ? null : exactOperation(ratio, "*", base);
    return value === null ? [] : [{ expression, result: canonicalExactValue(value) }];
  }
  const tokens = tokenizeArithmetic(expression);
  if (!tokens) return [];
  const result = evaluateTokens(tokens);
  return result === null ? [] : [{ expression, result }];
}

function deriveRequiredLiterals(request: string, forbiddenTerms: string[]): string[] {
  const values: string[] = [];
  const pattern = /\b(?:include|mention|keep|preserve|retain|use|leave|do\s+not\s+change|don't\s+change)(?:\s+[\p{L}\p{N}_-]+){0,6}\s+(?:exactly\s+)?["“]([^"”\r\n]{1,200})["”]/giu;
  for (const match of request.matchAll(pattern)) {
    const literal = match[1];
    const prefix = request.slice(0, match.index ?? 0).split(/[.;!?\n]/u).at(-1) ?? "";
    const politeDirective = /^\s*(?:please\s+)?(?:can|could|would|will)\s+you\s+(?:please\s+)?$/iu.test(prefix);
    const adviceFraming = !politeDirective && (
      /\b(?:should|can|could|would|do)\s+(?:i|we|you)\b|\bhow\s+(?:do|can|should|would)\s+(?:i|we|you)\b/iu.test(prefix)
      || /^\s*(?:is|are|why|who|what|when|where|how)\b/iu.test(prefix)
      || /\b(?:okay|wise|best\s+way|whether|advice)\b/iu.test(prefix)
    );
    const negatedCommand = /\b(?:do\s+not|don't|never)\b/iu.test(prefix)
      && !/\b(?:do\s+not|don't)\s+forget\s+to\s*$/iu.test(prefix);
    const explicitlyForbidden = forbiddenTerms.some((term) => term.toLocaleLowerCase("en-US") === literal.toLocaleLowerCase("en-US"));
    if (!adviceFraming && !negatedCommand && !explicitlyForbidden) values.push(literal);
  }
  return unique(values).slice(0, 8);
}

function hasMechanicalContract(contract: AnswerContract) {
  return Boolean(contract.maxWords || contract.exactWords || contract.sentenceCount || (contract.list && contract.list.style !== "outline") || contract.noBullets
    || contract.allowedLiterals || contract.commaSeparatedOnly || contract.lowercaseWords || contract.forbiddenTerms.length);
}

export function deriveFinishVerificationPlan(contract: AnswerContract): FinishVerificationPlan {
  const request = contract.latestRequest;
  const frame = deriveSemanticTaskFrame(request);
  const arithmeticFacts = deriveArithmeticFacts(request);
  const requiredLiterals = deriveRequiredLiterals(request, contract.forbiddenTerms);
  const codeRequested = requestsCodeArtifact(request);
  const checks: FinishVerificationCheck[] = ["completion"];
  if (hasMechanicalContract(contract)) checks.push("requirements");
  if (arithmeticFacts.length) checks.push("arithmetic");
  if (codeRequested) checks.push("code-structure");
  if (requiredLiterals.length) checks.push("preservation");
  const shouldVerify = checks.length > 1 || frame?.intent === "compose";
  return { shouldVerify, checks: unique(checks), arithmeticFacts, requiredLiterals, codeRequested };
}

export function deterministicArithmeticAnswer(plan: FinishVerificationPlan): string | null {
  if (plan.arithmeticFacts.length !== 1 || plan.checks.some((check) => check !== "completion" && check !== "arithmetic")) return null;
  return `The verified result is ${plan.arithmeticFacts[0].result}.`;
}

function inspectSentenceCount(answer: string) {
  const sentenceStarter = "He|She|They|It|We|I|This|That|The|Then";
  const ambiguousInitialismBoundary = /\b(?:[A-Z]\.){2,}(?=\s+\p{Lu})/u.test(answer);
  const protectedAbbreviations = answer
    .replace(new RegExp(`\\b(?:Mr|Mrs|Ms|Dr|Prof|St)\\.(?=\\s+(?!(?:${sentenceStarter})\\b)[\\p{L}][\\p{L}'’-]*)`, "gu"), (value) => value.slice(0, -1) + "\uE000")
    .replace(/\b(?:Fig|Eq|No)\.(?=\s+\d)/gu, (value) => value.slice(0, -1) + "\uE000")
    .replace(/\b(?:e\.g|i\.e)\.(?=\s+\p{Ll})/gu, (value) => value.replaceAll(".", "\uE000"))
    .replace(/\b(?:a\.m|p\.m)\.(?=\s+(?:\p{Ll}|\d))/gu, (value) => value.replaceAll(".", "\uE000"))
    .replace(/\b(?:vs|etc)\.(?=\s+\p{Ll})/gu, (value) => value.slice(0, -1) + "\uE000")
    .replace(/\b(?:[A-Z]\.){2,}(?=\s+\p{Ll})/gu, (value) => value.replaceAll(".", "\uE000"));
  const normalizedBoundaries = protectedAbbreviations.replace(/([.!?])["'”’\])]+(?=\s+)/gu, "$1");
  const segments = normalizedBoundaries.trim().split(/(?<=[.!?])\s+|\r?\n+/u);
  return { count: segments.filter((segment) => /[\p{L}\p{N}]/u.test(segment)).length, ambiguousInitialismBoundary };
}

function inspectCodeFences(answer: string) {
  const blocks: Array<{ language: string; code: string }> = [];
  let open: { language: string; lines: string[]; marker: "`" | "~"; length: number } | null = null;
  let malformed = false;
  for (const line of answer.split(/\r?\n/u)) {
    if (!open) {
      const opening = parseFenceOpening(line);
      if (!opening) continue;
      if (opening.malformed) { malformed = true; continue; }
      open = { language: opening.language, lines: [], marker: opening.marker, length: opening.length };
      continue;
    }
    if (isFenceClosing(line, open.marker, open.length)) {
      blocks.push({ language: open.language, code: open.lines.join("\n") });
      open = null;
      continue;
    }
    open.lines.push(line);
  }
  return { blocks, malformed, unclosed: open !== null };
}

function parseFenceOpening(line: string): { marker: "`" | "~"; length: number; language: string; malformed: boolean } | null {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
  if (!match) return null;
  const marker = match[1][0] as "`" | "~";
  const info = match[2].trim();
  return {
    marker,
    length: match[1].length,
    language: info.split(/\s+/u)[0]?.toLowerCase() ?? "",
    malformed: marker === "`" && info.includes("`"),
  };
}

function isFenceClosing(line: string, marker: "`" | "~", minimumLength: number) {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/u);
  return Boolean(match && match[1][0] === marker && match[1].length >= minimumLength);
}

function linesOutsideFencedCode(answer: string) {
  let fenced: { marker: "`" | "~"; length: number } | null = null;
  const lines: string[] = [];
  for (const line of answer.split(/\r?\n/u)) {
    if (!fenced) {
      const opening = parseFenceOpening(line);
      if (opening && !opening.malformed) { fenced = { marker: opening.marker, length: opening.length }; continue; }
    } else if (isFenceClosing(line, fenced.marker, fenced.length)) { fenced = null; continue; }
    if (!fenced) lines.push(line);
  }
  return lines;
}

function visibleMarkdownText(node: MarkdownNode, includeNestedLists = true, includeFencedCode = true, preserveSoftBreaks = false): string {
  if (node.type === "html" || node.type === "definition" || node.type === "image" || node.type === "imageReference") return "";
  if (node.type === "code" && !includeFencedCode) return "";
  if (node.type === "text" || node.type === "inlineCode") {
    const value = stripDefaultIgnorables(node.value ?? "");
    return preserveSoftBreaks ? value : value.replace(/\r?\n/gu, " ");
  }
  if (node.type === "code") return stripDefaultIgnorables(node.value ?? "");
  if (node.type === "break") return preserveSoftBreaks ? "\n" : " ";
  if (!node.children?.length) return "";
  const separator = ["root", "blockquote", "list", "listItem", "table", "tableRow"].includes(node.type) ? "\n" : "";
  return node.children
    .filter((child) => includeNestedLists || child.type !== "list")
    .map((child) => visibleMarkdownText(child, includeNestedLists, includeFencedCode, preserveSoftBreaks))
    .filter(Boolean)
    .join(separator);
}

function stripDefaultIgnorables(value: string) {
  return value.replace(/[\p{Default_Ignorable_Code_Point}\u2800]/gu, "");
}

function inspectRenderedMarkdown(answer: string) {
  const root = markdownParser.parse(answer) as MarkdownNode;
  const lists: Array<{ ordered: boolean; items: string[] }> = [];
  let hasCode = false;
  const placeholderLinkLabels: string[] = [];
  const codeValues: string[] = [];
  const visit = (node: MarkdownNode) => {
    if (node.type === "code" || node.type === "inlineCode") {
      hasCode = true;
      if (node.type === "code") codeValues.push(stripDefaultIgnorables(node.value ?? ""));
    }
    if ((node.type === "link" || node.type === "linkReference")
      && /^(?:(?:to\s+be\s+)?continued(?:\s+(?:below|later|next|soon|shortly|here)|\s+in\s+(?:the\s+)?next\s+message)?|continue|truncated)$/iu.test(visibleMarkdownText(node).trim())) {
      placeholderLinkLabels.push(visibleMarkdownText(node).trim());
    }
    if (node.type === "list") {
      lists.push({
        ordered: Boolean(node.ordered),
        items: (node.children ?? []).filter((child) => child.type === "listItem").map((item) => visibleMarkdownText(item, false)),
      });
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  const text = visibleMarkdownText(root);
  const terminalText = text.trim().replace(/[.!?'"”’\])}\u2013\u2014-]+$/u, "").trimEnd().toLocaleLowerCase("en-US");
  const hasPlaceholderLink = placeholderLinkLabels.some((label) => {
    const normalized = label.toLocaleLowerCase("en-US");
    if (!terminalText.endsWith(normalized)) return false;
    const prefix = terminalText.slice(0, -normalized.length);
    if (prefix && !/[^\p{L}\p{N}_]$/u.test(prefix)) return false;
    const contextMarksPlaceholder = !prefix
      || /(?:^|\b)(?:draft|placeholder|response|answer|output|more|to\s+be|part\s+\d+|section\s+\d+)\s*[:(“'"-]*\s*$/iu.test(prefix);
    if (/^(?:truncated|continue|to\s+be\s+continued|continued\s+(?:below|later|next|here)|continued\s+in\s+(?:the\s+)?next\s+message)$/iu.test(normalized)) return true;
    return contextMarksPlaceholder;
  });
  return {
    text,
    outsideCodeText: visibleMarkdownText(root, true, false),
    outsideCodeLineText: visibleMarkdownText(root, true, false, true),
    lists,
    hasCode,
    hasPlaceholderLink,
    codeValues,
  };
}

function hasVisualBulletLines(text: string) {
  const markers = text.split(/\r?\n/u)
    .map((line) => line.match(/^\s*([^\p{L}\p{N}\s])\s+(?=[\p{L}\p{N}\p{S}])/u)?.[1])
    .filter((marker): marker is string => Boolean(marker));
  return markers.some((marker) => /[•‣⁃⁌⁍‧∙◘◦○●◉■□▪▫◆◇►▸▶▷➢➣➤❖☚☛☜☞☝☟]/u.test(marker));
}

function listItemStats(rendered: ReturnType<typeof inspectRenderedMarkdown>, style: "numbered" | "bullets") {
  const items = rendered.lists.filter((list) => list.ordered === (style === "numbered")).flatMap((list) => list.items);
  return { count: items.filter((item) => /[\p{L}\p{N}\p{S}]/u.test(item)).length, empty: items.some((item) => !/[\p{L}\p{N}\p{S}]/u.test(item)) };
}

function contractIssues(answer: string, contract: AnswerContract, rendered: ReturnType<typeof inspectRenderedMarkdown>): FinishVerificationIssue[] {
  const issues: FinishVerificationIssue[] = [];
  const visibleAnswer = rendered.text;
  const words = visibleAnswer.trim().split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
  if (contract.maxWords && words > contract.maxWords) issues.push({ code: "word-count", message: `Use at most ${contract.maxWords} words.` });
  if (contract.exactWords && words !== contract.exactWords) issues.push({ code: "word-count", message: `Use exactly ${contract.exactWords} words.` });
  if (contract.sentenceCount) {
    const sentenceInspection = inspectSentenceCount(visibleAnswer);
    if (sentenceInspection.ambiguousInitialismBoundary) {
      issues.push({ code: "sentence-count", message: "Confirm the requested sentence count manually because an initialism creates an ambiguous boundary." });
    } else if (sentenceInspection.count !== contract.sentenceCount) {
      issues.push({ code: "sentence-count", message: `Use exactly ${contract.sentenceCount} sentences.` });
    }
  }
  if (contract.list?.style === "numbered") {
    const list = listItemStats(rendered, "numbered");
    if (list.empty || list.count !== contract.list.count) issues.push({ code: "list-count", message: `Return exactly ${contract.list.count} numbered items.` });
  }
  if (contract.list?.style === "bullets") {
    const list = listItemStats(rendered, "bullets");
    if (list.empty || list.count !== contract.list.count) issues.push({ code: "list-count", message: `Return exactly ${contract.list.count} bullet items.` });
  }
  if (contract.noBullets && (rendered.lists.length || hasVisualBulletLines(rendered.outsideCodeLineText))) {
    issues.push({ code: "format", message: "Remove bullet and numbered-list markers." });
  }
  if (contract.allowedLiterals && !contract.allowedLiterals.includes(answer.trim())) issues.push({ code: "format", message: `Return only one allowed token: ${contract.allowedLiterals.join(" or ")}.` });
  if (contract.commaSeparatedOnly && !/^[\p{L}\p{N}]+(?:,[\p{L}\p{N}]+)*$/u.test(answer.trim())) issues.push({ code: "format", message: "Return comma-separated tokens only." });
  if (contract.lowercaseWords && /[\p{Lu}\p{Lt}]/u.test(visibleAnswer)) issues.push({ code: "format", message: "Use lowercase words only." });
  for (const term of contract.forbiddenTerms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const isWord = contract.forbiddenWords.some((word) => word.toLocaleLowerCase("en-US") === term.toLocaleLowerCase("en-US"));
    const present = isWord
      ? new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "iu").test(visibleAnswer)
      : visibleAnswer.toLocaleLowerCase("en-US").includes(term.toLocaleLowerCase("en-US"));
    if (present) issues.push({ code: "forbidden-term", message: `Remove the forbidden term ${JSON.stringify(term)}.` });
  }
  return issues;
}

function isCanonicalArithmeticAnswer(answer: string, expected: string) {
  const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^(?:the\\s+(?:(?:verified\\s+)?(?:result|answer))\\s+is\\s+)?${escaped}[.!]?$`, "iu").test(answer.trim());
}

export function auditFinishedAnswer(answer: string, plan: FinishVerificationPlan, contract: AnswerContract): FinishVerificationIssue[] {
  const source = answer.trimEnd();
  const trimmed = source.trim();
  const rendered = inspectRenderedMarkdown(source);
  const issues = contractIssues(source, contract, rendered);
  const fenceInspection = inspectCodeFences(source);
  const visibleTrimmed = rendered.text.trim();
  const outsideCode = rendered.outsideCodeText;
  const hasVisibleContent = /[\p{L}\p{N}\p{S}]/u.test(rendered.text)
    || rendered.codeValues.some((value) => value.trim().length > 0);
  if (!hasVisibleContent || /(?:…|\.\.\.)["'”’\])}]*$/u.test(visibleTrimmed) || /:\s*$/u.test(visibleTrimmed)
    || rendered.hasPlaceholderLink
    || /\b(?:TODO|TBD)\b|\[(?:(?:to\s+be\s+)?continued(?:\s+(?:below|later|next))?|continue|truncated)\]/i.test(outsideCode)
    || /\bpart\s+\d+\s+of\s+\d+\b|\b(?:more|continued)\s+(?:below|later|next)\b/i.test(outsideCode)
    || fenceInspection.malformed || fenceInspection.unclosed) {
    issues.push({ code: "incomplete", message: "Return a complete answer without truncation, placeholders, or an unfinished code fence." });
  }
  for (const fact of plan.arithmeticFacts) {
    if (!isCanonicalArithmeticAnswer(trimmed, fact.result)) issues.push({ code: "arithmetic", message: `Return only the deterministically verified calculation ${fact.expression} = ${fact.result}.` });
  }
  for (const literal of plan.requiredLiterals) {
    if (!rendered.text.includes(literal)) issues.push({ code: "preservation", message: `Preserve this exact user-supplied text: ${JSON.stringify(literal)}.` });
  }
  if (plan.codeRequested) {
    const blocks = fenceInspection.blocks;
    if (!blocks.length) issues.push({ code: "missing-code", message: "Return the requested code in at least one complete fenced code block." });
    else if (blocks.some((block) => !stripDefaultIgnorables(block.code).replace(/\s/gu, ""))) issues.push({ code: "code-structure", message: "Return non-empty content in every fenced code block." });
  }
  return issues.filter((issue, index, all) => all.findIndex((candidate) => candidate.code === issue.code && candidate.message === issue.message) === index);
}

function isFormatOnlyRepairIssue(issue: FinishVerificationIssue) {
  return issue.code === "list-count" && /bullet items\.$/u.test(issue.message)
    || issue.code === "format" && issue.message === "Remove bullet and numbered-list markers.";
}

export function buildFinishRepairMessages(messages: ChatMessage[], draft: string, issues: FinishVerificationIssue[]): ChatMessage[] | null {
  if (!issues.length || issues.some((issue) => !isFormatOnlyRepairIssue(issue))) return null;
  if (inspectRenderedMarkdown(draft).hasCode) return null;
  if (issues.some((issue) => issue.code === "format")
    && linesOutsideFencedCode(draft).some((line) => /^\s*\d+[.)]\s+/u.test(line))) return null;
  return [
    ...messages,
    { role: "assistant", content: draft },
    { role: "system", content: `FORMAT-ONLY REPAIR: Change only whitespace and leading list markers. Do not add, delete, replace, or reorder any word, number, symbol, or internal punctuation. Fix only:\n${issues.map((issue) => `- ${issue.message}`).join("\n")}\nReturn only the reformatted answer.` },
  ];
}

function formatPayload(value: string) {
  let fenced = false;
  return value.split(/\r?\n/u)
    .map((line) => {
      if (/^\s*```/u.test(line)) { fenced = !fenced; return line.trim(); }
      return (fenced ? line : line.replace(/^\s*[-*+•]\s+/u, "")).trim();
    })
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/gu, " ");
}

export function chooseFinishedAnswer(original: string, candidate: string, plan: FinishVerificationPlan, contract: AnswerContract) {
  const originalIssues = auditFinishedAnswer(original, plan, contract);
  const candidateIssues = auditFinishedAnswer(candidate, plan, contract);
  if (!candidate.trim() || inspectRenderedMarkdown(original).hasCode || inspectRenderedMarkdown(candidate).hasCode
    || formatPayload(candidate) !== formatPayload(original) || candidateIssues.length >= originalIssues.length) {
    return { answer: original, repaired: false, issues: originalIssues };
  }
  return { answer: candidate, repaired: true, issues: candidateIssues };
}

export function finishVerificationReceipt(plan: FinishVerificationPlan, repaired: boolean, issues: FinishVerificationIssue[]): FinishVerificationReceipt {
  const manualReview = issues.some((issue) => issue.code === "sentence-count" && issue.message.includes("ambiguous boundary"))
    ? "ambiguous-sentence-boundary" as const
    : undefined;
  return {
    version: FINISH_VERIFICATION_VERSION,
    status: issues.length ? "warning" : repaired ? "repaired" : "passed",
    checks: plan.checks,
    issueCount: Math.min(issues.length, 20),
    ...(manualReview ? { manualReview } : {}),
  };
}
