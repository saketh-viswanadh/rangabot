import type { ChatMessage } from "./providers/types.ts";

export type ConversationalAnalysisIntent = {
  requested: boolean;
  requiresDataset: boolean;
  explicitlyDeclined: boolean;
  attachmentCandidate?: boolean;
};

export type ResourcePreference = "use" | "ignore" | "unspecified";

const strongAnalysisIntent = /\b(?:calculate|compute|count|total|sum|average|mean|median|minimum|maximum|percent|percentage|rate|ratio|trend|growth|decline|increase|decrease|correlation|distribution|variance|standard deviation|outlier|anomal(?:y|ies)|rank|top|bottom|highest|lowest|group(?:ed|ing)?|segment(?:ed|ation)?|breakdown|forecast|predict|statistic(?:al|ally|s)?|significant|visuali[sz]e|chart|plot)\b/i;
const conditionalAnalysisIntent = /\b(?:analy[sz]e|analysis|compare|comparison|describe|explain|filter|inspect|overview|query|show|summari[sz]e|tell|use|list)\b/i;
const datasetSubject = /\b(?:attachment|(?:attached|selected|uploaded|my|our|this|the)\s+(?:dataset|data set|data|database|table|file|csv|parquet|duckdb|rows?|records?|columns?|fields?))\b/i;
const explicitDatasetBinding = /\b(?:attachment|(?:attached|selected|uploaded|my|our|this)\s+(?:dataset|data set|data|database|table|file|csv|parquet|duckdb|rows?|records?|columns?|fields?))\b/i;
const operationalDataRequest = /\b(?:analy[sz]e|filter|inspect|query|show|summari[sz]e|list)\b[\s\S]{0,80}\b(?:top|bottom|unmatched|duplicate|missing|null|rows?|records?|columns?|fields?)\b/i;
const bareDatasetOperation = /^\s*(?:please\s+)?(?:analy[sz]e|filter|inspect|query|show|summari[sz]e|list)\b[\s\S]{0,70}\b(?:dataset|data set|data|database|table|csv|parquet|duckdb|rows?|records?|columns?|fields?)\b/i;
const instructionalDataFraming = /\b(?:definition|meaning|concept|format|bias|schema|syntax|file\s+type|beginner|in\s+general|generally|normalization|terminology|tutorial|polic(?:y|ies)|retention|constraints?|rules?|best\s+practices?|ways?\s+to|tips?|advice|documentation|privacy|ethics|parsing|code|types?|examples?|design|javascript|typescript|python|sql|what\s+(?:is|are)\s+(?:an?\s+)?(?:average|mean|median|trend|rate|ratio|table|database|dataset)|what\s+does[\s\S]{0,30}\bmean|how\s+(?:it|they|this|that|rows?|columns?|data|datasets?|csv|parquet)\s+(?:works?|is\s+used))\b/i;
const deicticDataRequest = /\b(?:show|explain|inspect|describe)\b[\s\S]{0,30}\b(?:its|their)\s+(?:schema|columns?|rows?|fields?)\b|\bwhat\s+(?:columns?|rows?|fields?)\s+does\s+it\s+have\b|^\s*(?:summari[sz]e|analy[sz]e|filter|inspect|query)\s+it\b|\b(?:give\s+me\s+an?\s+overview\s+of|what(?:'s|\s+is)\s+(?:in|inside))\s+it\b/i;
const naturalTabularQuestion = /\bwhat\s+(?:is|was|were|are)\b(?=[\s\S]{0,100}\b(?:our|my|last|this|current|previous|today|yesterday|daily|weekly|monthly|quarterly|yearly|january|february|march|april|may|june|july|august|september|october|november|december|by|per|during|between)\b)[\s\S]{0,45}\b(?:total|average|mean|minimum|maximum|rate|ratio|percentage|count)\s+(?:of\s+)?[\p{L}][\p{L}-]{2,}\b|\bwhich\s+[\p{L}][\p{L}-]{2,}(?:\s+[\p{L}][\p{L}-]{2,}){0,4}\s+(?:had|has|was|is|were|are)\s+(?:the\s+)?(?:highest|lowest|most|least)\s+(?:sales|revenue|orders?|profit|margin|conversion|churn|cost|spend|usage|volume|score|rate)\b|\bhow\s+many\s+(?:rows?|records?|columns?|fields?)\b|\bhow\s+many\s+[\p{L}][\p{L}-]{2,}(?:\s+[\p{L}][\p{L}-]{2,}){0,2}\s+(?:churned|converted|purchased|ordered|returned|cancelled|renewed|retained|completed|failed|passed|shipped|delivered|opened|closed|recovered|admitted|discharged|are\s+(?:active|inactive|pending|paid|unpaid|eligible))\b|\bwhy\s+did\s+[\p{L}][\p{L}-]{2,}(?:\s+[\p{L}][\p{L}-]{2,}){0,3}\s+(?:increase|decrease|decline|grow|drop|rise|fall)\b/iu;
const analyticalObjectOperation = /\b(?:compare|break\s+down|rank|calculate|compute|group|segment|show)\b[\s\S]{0,70}\b(?:by|rate|ratio|trend|duplicate|unmatched|top|bottom|highest|lowest)\b|\bfind\s+(?:the\s+)?(?:duplicate|unmatched|missing|top|bottom)\b[\s\S]{0,50}\b[\p{L}][\p{L}-]{2,}\b|\b(?:forecast|predict|plot|chart|visuali[sz]e)\b[\s\S]{0,60}\b[\p{L}][\p{L}-]{2,}\b|\bwhat\s+caused\s+[\p{L}][\p{L}-]{2,}(?:\s+[\p{L}][\p{L}-]{2,}){0,3}\s+to\s+(?:increase|decrease|decline|grow|drop|rise|fall)\b/iu;
const analyticalEntitySignal = /\b(?:revenue|sales?|orders?|customers?|users?|products?|profits?|margins?|conversions?|churn|costs?|spend|usage|volume|scores?|transactions?|sessions?|leads?|accounts?|tickets?|employees?|inventory|returns?|refunds?|retention|growth|rows?|records?|columns?|fields?|subscriptions?|shipments?|deliveries?|payments?|invoices?|claims?)\b/i;
const aggregateShorthand = /^\s*(?=[\s\S]{0,100}\b(?:revenue|sales?|orders?|customers?|users?|products?|profits?|margins?|conversions?|churn|costs?|spend|usage|volume|scores?|transactions?|sessions?|leads?|accounts?|tickets?|employees?|inventory|returns?|refunds?|retention|growth|rows?|records?|columns?|fields?|subscriptions?|shipments?|deliveries?|payments?|invoices?|claims?)\b)(?:(?:average|avg|mean|median|total|sum|count|minimum|min|maximum|max|top|bottom)\s+(?:\d+\s+)?[\p{L}][\p{L}\d_-]*(?:\s+[\p{L}][\p{L}\d_-]*){0,5}|[\p{L}][\p{L}\d_-]*(?:\s+[\p{L}][\p{L}\d_-]*){0,4}\s+(?:by|per)\s+[\p{L}][\p{L}\d_-]*(?:\s+[\p{L}][\p{L}\d_-]*){0,2}|what\s+(?:columns?|fields?)\s+(?:are\s+there|exist))\s*[?.!]*\s*$/iu;
const dimensionalAnalysis = /\b(?:compare|break\s+down|rank|calculate|compute|group|segment|aggregate|summari[sz]e|show|plot|chart|visuali[sz]e)\b[\s\S]{0,70}\bby\s+[\p{L}][\p{L}\d_-]*\b/iu;
const unrelatedAdviceQuestion = /\bhow\s+many\b[\s\S]{0,70}\bshould\s+(?:i|you|an?|the)\b|\bwhich\s+(?:option|choice|approach|way)\b[\s\S]{0,30}\b(?:best|better|worst)\b|\bwhat\s+is\s+(?:the\s+)?(?:average|mean|median|typical)\b(?![\s\S]{0,60}\b(?:our|my|this|last|current|by|during)\b)/i;
const implicitMetricQuestion = /\bhow many\b|\bwhat (?:is|was|were|are)\b.{0,80}\b(?:total|average|mean|minimum|maximum|rate|ratio|percentage|value|count)\b/i;
const ambiguousMetricQuestion = /\b(?:which|what)\b.{0,60}\b(?:best|most valuable|highest-performing|lowest-performing)\b/i;
const analyticalBoundaryQuestion = /\b(?:why did|what caused|is this (?:healthy|good|bad)|should (?:we|i))\b/i;
const contextualAnalysisFollowUp = /^(?:and|also|but|so|then|what about|how about|why|which|show|compare|break it|drill|filter|only|now)\b/i;
const attachedDataExploration = /\b(?:what (?:can you|do you) (?:find|notice|see)|what(?:'s| is) (?:in|inside) (?:it|this)|tell me (?:a little )?(?:about|what is in) (?:the |this |selected )?data|give me an? (?:overview|summary) of (?:the |this |selected )?data)\b/i;
const explicitVaultReference = /\b(?:knowledge vault|teacher mode|my (?:books|documents|sources|vault)|local (?:books|documents|sources|vault)|vault sources?|(?:use|search|query|check|open|look\s+in|answer\s+from)\s+(?:the\s+)?vault|from\s+(?:the\s+)?vault)\b/i;
const vaultSubject = /\b(?:knowledge vault|teacher mode|my (?:books|documents|sources|vault)|local (?:books|documents|sources|vault)|vault sources?|(?:the\s+)?vault)\b/i;
const dataAuthoritySubject = /\b(?:attachment|(?:attached|selected|uploaded|old|new|current|my|our|this|that|the)\s+(?:dataset|data set|data|database|table|file|csv|parquet|duckdb|rows?|records?|columns?|fields?)|dataset|data set|data|database|table|csv|parquet|duckdb|rows?|records?|columns?|fields?)\b/i;
const repositorySubject = /\b(?:attachment|excerpt|(?:attached|selected|old|new|current|this|that|the)\s+(?:code|file|excerpt|repository|repo|codebase|source file|script|function|class|query)|code|file|repository|repo|codebase|source file|script|function|class|code excerpt)\b/i;
const wordSubject = /\b(?:word|docx|word\s+document|word\s+report|document)\b/i;
const negativeDirective = /\b(?:do not|don't|dont|never|ignore|skip|avoid|without|cancel|stop|never\s+mind|changed\s+my\s+mind|forget\s+(?:it|that|this))\b|\b(?:instead\s+of|rather\s+than)\b|\bactually\s*,?\s*no\b|(?:^|[, ]+)not\b|^\s*no\b/i;
const genericResourceReference = /\b(?:it|that|this|them|those|one|attachment|excerpt)\b/i;
const genericCorrection = /^\s*(?:please\s+)?(?:(?:actually|instead|rather|now|then|on\s+second\s+thought)\s*,?\s*)*(?:(?:do not|don't|dont)\s+do(?:\s+(?:it|that|this))?|(?:do not|don't|dont|never|ignore|skip|cancel|stop)(?:\s+(?:it|that|this|them))?|no(?:\s+thanks)?|never\s+mind|changed\s+my\s+mind|forget\s+(?:it|that|this))\s*[!.]*\s*$/i;
const genericNegativeAction = /\b(?:ignore|skip|avoid|cancel|stop)\b/i;
const dataPositiveDirective = /\b(?:use|analy[sz]e|filter|inspect|query|show|summari[sz]e|list|compare|count|calculate|compute|average|rank|group|segment|forecast|predict|plot|chart|visuali[sz]e|explain|describe|open|read|check)\b/i;
const repositoryPositiveDirective = /\b(?:use|review|explain|inspect|debug|refactor|search|find|read|check|compare|summari[sz]e|describe|suggest)\b|\bwhat\s+does\b/i;
const vaultPositiveDirective = /\b(?:use|search|query|check|open|look|answer|cite|compare|explain|teach|summari[sz]e)\b|\b(?:from|in)\s+(?:the\s+)?vault\b|\bwhat\s+(?:can|do)\b/i;
const wordPositiveDirective = /\b(?:create|make|generate|export|prepare|write)\b/i;
const dataGenericOptOut = /\banswer\s+(?:generally|normally|without\s+(?:it|that|the\s+attachment))\b/i;
const repositoryGenericOptOut = dataGenericOptOut;
const pendingWordOptOut = /\b(?:chat\s+only|keep\s+(?:this|it)\s+in\s+chat|answer\s+(?:here|normally|in\s+chat)|changed\s+my\s+mind)\b/i;
const wordAdviceRequest = /\b(?:should|can|could|would|do)\s+i\s+(?:create|make|generate|export|prepare|write)\b[\s\S]{0,50}\b(?:word|docx|document)\b|\b(?:what(?:'s|\s+is)\s+(?:the\s+)?best\s+way\s+to|give\s+me\s+(?:the\s+)?steps?\s+to|explain\s+how\s+to|teach\s+me\s+how\s+to|how\s+to)\s+(?:create|make|generate|export|prepare|write)\b[\s\S]{0,50}\b(?:word|docx|document)\b/i;
const repositoryInstructionalRequest = /\b(?:how\s+(?:do|can|should|would)\s+(?:i|you|we)|best\s+practices?|tips?|advice|in\s+general|what\s+(?:is|are)|explain\s+how|teach\s+me\s+how)\b/i;
const explicitRepositoryBinding = /\b(?:(?:attached|selected|current|this|that|the)\s+(?:code|file|excerpt|repository|repo|codebase|source file|script|function|class|query)|code\s+excerpt|repository|repo|codebase|source\s+file|attachment|excerpt)\b/i;
const deicticRepositoryUse = /^\s*(?:what\s+does\s+this\s+do|(?:review|inspect|explain|debug|refactor|summari[sz]e)\s+(?:it|this)|find\s+(?:the\s+)?bug\s+in\s+(?:it|this))(?:\s+(?:please|for\s+me))?\s*[?.!]*\s*$/i;

function latestUserText(messages: ChatMessage[]) {
  return [...messages].reverse().find((message) => message.role === "user")?.content.trim() ?? "";
}

type MaterialResource = "data" | "repository" | "vault" | "word";

const materialSubjects: Record<MaterialResource, RegExp> = {
  data: dataAuthoritySubject,
  repository: repositorySubject,
  vault: vaultSubject,
  word: wordSubject,
};

function requestSegments(value: string) {
  return value.split(
    /[.;\n]+|,\s*(?=(?:actually|instead|rather|now|then|no|do not|don't|dont|never|ignore|skip|without|not|use|analy[sz]e|review|search|create|make|generate|export|prepare|write|answer|keep|cancel)\b)|\b(?:but|however)\b|\s+(?=(?:without|instead\s+of|rather\s+than)\b)|\s+(?=actually\s+(?:no|do not|don't|dont|never|ignore|skip|use|cancel|stop)\b)|\band\s+(?=(?:(?:actually|instead|rather|now|then)\s+)*(?:no|do not|don't|dont|never|ignore|skip|use|analy[sz]e|review|search|create|make|generate|export|prepare|write|answer|keep|cancel)\b)/i,
  ).map((segment) => segment.trim()).filter(Boolean);
}

function mentionedMaterialResources(value: string): MaterialResource[] {
  return (Object.entries(materialSubjects) as Array<[MaterialResource, RegExp]>)
    .filter(([, subject]) => subject.test(value))
    .map(([resource]) => resource);
}

function lastResourcePreference(
  value: string,
  resource: MaterialResource,
  positive: RegExp,
  options: { initiallySeen?: boolean; extraNegative?: RegExp } = {},
): ResourcePreference {
  const subject = materialSubjects[resource];
  let seen = Boolean(options.initiallySeen);
  let lastMentionedResources = new Set<MaterialResource>(options.initiallySeen ? [resource] : []);
  let preference: ResourcePreference = "unspecified";
  for (const segment of requestSegments(value.replace(/[’]/g, "'"))) {
    const mentionedResources = mentionedMaterialResources(segment);
    const mentionsSubject = subject.test(segment);
    const genericContinuation = seen && mentionedResources.length === 0 && lastMentionedResources.has(resource) && (
      genericCorrection.test(segment)
      || genericResourceReference.test(segment) && (positive.test(segment) || genericNegativeAction.test(segment))
      || resource === "word" && pendingWordOptOut.test(segment)
    );
    if (!mentionsSubject && !genericContinuation) {
      if (mentionedResources.length) lastMentionedResources = new Set(mentionedResources);
      continue;
    }
    if (mentionsSubject) seen = true;
    if (negativeDirective.test(segment) || options.extraNegative?.test(segment)) preference = "ignore";
    else if (positive.test(segment) || genericContinuation && /\b(?:use|do|create|make|generate|export|prepare|write|search|review|analy[sz]e)\b/i.test(segment)) preference = "use";
    if (mentionedResources.length) lastMentionedResources = new Set(mentionedResources);
  }
  return preference;
}

export function classifyConversationalAnalysis(messages: ChatMessage[]): ConversationalAnalysisIntent {
  const latest = latestUserText(messages);
  if (!latest) return { requested: false, requiresDataset: false, explicitlyDeclined: false };
  const dataPreference = lastResourcePreference(latest, "data", dataPositiveDirective, { extraNegative: dataGenericOptOut });
  const explicitlyDeclined = dataPreference === "ignore";
  const hadAnalysis = messages.slice(0, -1).some((message) => message.role === "assistant" && message.analysisTrace?.engine === "duckdb");
  const explicitBinding = explicitDatasetBinding.test(latest) && !explicitlyDeclined;
  const conceptual = instructionalDataFraming.test(latest) && !explicitBinding;
  const unrelatedAdvice = unrelatedAdviceQuestion.test(latest) && !explicitBinding;
  const boundDataset = dataPreference === "use" && explicitBinding
    || datasetSubject.test(latest) && !explicitlyDeclined && (!conceptual || explicitBinding);
  const hasAnalyticalEntity = analyticalEntitySignal.test(latest);
  const operationalRequest = operationalDataRequest.test(latest) && !conceptual && (hasAnalyticalEntity || explicitBinding);
  const analystIntent = !explicitlyDeclined && !conceptual && !unrelatedAdvice
    && (operationalRequest || bareDatasetOperation.test(latest) || naturalTabularQuestion.test(latest)
      || (hasAnalyticalEntity || explicitBinding) && (analyticalObjectOperation.test(latest) || dimensionalAnalysis.test(latest))
      || aggregateShorthand.test(latest) || explicitBinding && /\b(?:by|per)\b/i.test(latest)
      || (hasAnalyticalEntity || explicitBinding) && ambiguousMetricQuestion.test(latest));
  const deicticRequest = deicticDataRequest.test(latest) && !explicitlyDeclined;
  const exploratoryCandidate = attachedDataExploration.test(latest) && !explicitlyDeclined;
  const attachmentCandidate = !boundDataset && (analystIntent || exploratoryCandidate);
  const requested = !explicitlyDeclined && (
    strongAnalysisIntent.test(latest)
    || implicitMetricQuestion.test(latest)
    || ambiguousMetricQuestion.test(latest)
    || analyticalBoundaryQuestion.test(latest)
    || boundDataset && conditionalAnalysisIntent.test(latest)
    || operationalRequest
    || analystIntent
    || attachmentCandidate
    || deicticRequest
    || attachedDataExploration.test(latest)
    || hadAnalysis && contextualAnalysisFollowUp.test(latest)
  );
  const requiresDataset = requested && (boundDataset || analystIntent || deicticRequest || hadAnalysis && contextualAnalysisFollowUp.test(latest));
  return { requested, requiresDataset, explicitlyDeclined, ...(attachmentCandidate ? { attachmentCandidate: true } : {}) };
}

export function shouldRunSqlAnalysis(messages: ChatMessage[]) {
  return classifyConversationalAnalysis(messages).requested;
}

export function shouldPlanWordDocument(messages: ChatMessage[]) {
  const latestUser = latestUserText(messages);
  const lastCreated = messages.findLastIndex((message) => Boolean(message.wordArtifact));
  const lastIntent = messages.findLastIndex((message) => message.artifactIntent === "word");
  const pending = lastIntent > lastCreated;
  const preference = lastResourcePreference(latestUser, "word", wordPositiveDirective, { initiallySeen: pending, extraNegative: pendingWordOptOut });
  if (preference === "ignore") return false;
  if (wordAdviceRequest.test(latestUser)) return false;
  if (preference === "use") return true;
  return pending;
}

export function shouldAutoSearchKnowledge(question: string) {
  const normalized = question.trim();
  if (normalized.length < 8) return false;
  if (/^(hi|hello|hey|thanks|thank you|good (?:morning|afternoon|evening))[!. ]*$/i.test(normalized)) return false;
  return /\?|^(?:what|why|when|where|who|which|how|explain|define|compare|summarize|teach|tell me about|help me understand)\b/i.test(normalized)
    || /\b(?:python|numpy|pandas|sql|spark|pyspark|databricks|snowflake|data science|machine learning|\bai\b|models?|statistics|visuali[sz]ation|history|mythology|algorithm)\b/i.test(normalized);
}

export function vaultPreference(question: string): ResourcePreference {
  const preference = lastResourcePreference(question, "vault", vaultPositiveDirective);
  if (preference !== "unspecified") return preference;
  return explicitVaultReference.test(question) ? "use" : "unspecified";
}

export function repositoryPreference(question: string): ResourcePreference {
  const preference = lastResourcePreference(question, "repository", repositoryPositiveDirective, { extraNegative: repositoryGenericOptOut });
  if (preference === "ignore") return preference;
  if (deicticRepositoryUse.test(question)) return "use";
  if (preference === "use" && repositoryInstructionalRequest.test(question) && !explicitRepositoryBinding.test(question)) return "unspecified";
  return preference;
}
