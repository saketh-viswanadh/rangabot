import type { ChatMessage } from "./providers/types.ts";

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
