import { NextResponse } from "next/server";
import { MAX_CONVERSATION_IMPORT_BYTES, parseConversationMarkdown } from "@/lib/conversation-markdown";
import { createConversation } from "@/lib/conversations";
import { assertExternalImportAccess } from "@/lib/desktop-external-filesystem-policy";
import { assertProfileAcceptsExternalUserData, StaleProfileRequestError, withProfileRequest } from "@/lib/profile-request";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    return await withProfileRequest(request, { kind: "import", label: "conversation import" }, async () => {
      assertProfileAcceptsExternalUserData();
      assertExternalImportAccess("conversation-import");
      const body = (await request.json()) as { markdown?: unknown; projectId?: unknown };
      if (typeof body.markdown !== "string" || Buffer.byteLength(body.markdown, "utf8") > MAX_CONVERSATION_IMPORT_BYTES) {
        return NextResponse.json({ error: "A Rangabot Markdown export up to 2 MB is required." }, { status: 400 });
      }
      const messages = parseConversationMarkdown(body.markdown);
      const projectId = typeof body.projectId === "string" ? body.projectId : null;
      return NextResponse.json({ conversation: createConversation(messages, projectId) }, { status: 201 });
    });
  } catch (error) {
    const status = error instanceof StaleProfileRequestError ? 409
      : error instanceof Error && error.message.includes("unavailable") ? 403
        : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Conversation import failed." }, { status });
  }
}
