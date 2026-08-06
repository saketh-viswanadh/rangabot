import { handleAnalyticsChat } from "./analytics-chat-handler.ts";
import { formatCodeContext, type CodeContextRequest } from "./code-context.ts";
import { answerDeterministicConversationRequest } from "./conversation-orchestration.ts";
import { answerDirectMemoryQuestion, directMemoryTitles } from "./memories.ts";
import { getAllowedRepository, type AllowedRepository } from "./repositories.ts";
import { previewRepositoryFile, type CodePreview } from "./repository-search.ts";
import type { ChatMessage } from "./providers/types.ts";

export type CoreChatDispatchInput = {
  messages: ChatMessage[];
  codeContext?: CodeContextRequest;
  datasetId?: string;
  conversationId?: string;
  signal?: AbortSignal;
};

export type CoreChatDispatchDependencies = {
  deterministic(messages: ChatMessage[]): string | null;
  directMemory(question: string): string | null;
  memoryTitles(question: string): string[];
  getRepository(id: string): AllowedRepository | null;
  preview(repository: AllowedRepository, path: string, line: number): CodePreview;
  formatContext(repository: AllowedRepository, preview: CodePreview): string;
  analytics(input: CoreChatDispatchInput): Promise<Response | null>;
};

const defaultDependencies: CoreChatDispatchDependencies = {
  deterministic: answerDeterministicConversationRequest,
  directMemory: answerDirectMemoryQuestion,
  memoryTitles: directMemoryTitles,
  getRepository: getAllowedRepository,
  preview: previewRepositoryFile,
  formatContext: formatCodeContext,
  analytics: handleAnalyticsChat,
};

export async function dispatchCoreChat(input: CoreChatDispatchInput, dependencies: CoreChatDispatchDependencies = defaultDependencies) {
  const latestQuestion = [...input.messages].reverse().find((message) => message.role === "user")?.content ?? "";
  const deterministic = dependencies.deterministic(input.messages);
  if (deterministic) {
    return {
      response: new Response(deterministic, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Rangabot-Response": "deterministic" } }),
      localCodeContext: null,
    };
  }
  const memory = dependencies.directMemory(latestQuestion);
  if (memory) {
    const titles = dependencies.memoryTitles(latestQuestion);
    return {
      response: new Response(memory, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "X-Rangabot-Memory": "direct",
          ...(titles.length ? { "X-Rangabot-Memory-Titles": encodeURIComponent(JSON.stringify(titles)) } : {}),
        },
      }),
      localCodeContext: null,
    };
  }

  let localCodeContext: string | null = null;
  if (input.codeContext) {
    const repository = dependencies.getRepository(input.codeContext.repositoryId);
    if (!repository) return { response: Response.json({ error: "That folder is no longer approved." }, { status: 400 }), localCodeContext };
    localCodeContext = dependencies.formatContext(repository, dependencies.preview(repository, input.codeContext.path, input.codeContext.line));
  }

  const analytics = await dependencies.analytics(input);
  return { response: analytics, localCodeContext };
}
