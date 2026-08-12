import { NextResponse } from "next/server";
import { MAX_CONVERSATION_IMPORT_BYTES, parseConversationMarkdown } from "@/lib/conversation-markdown";
import { createConversation } from "@/lib/conversations";
import { assertExternalImportAccess } from "@/lib/desktop-external-filesystem-policy";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try { assertExternalImportAccess("conversation-import"); }
  catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Conversation import is unavailable." }, { status: 403 });
  }
  const body = (await request.json()) as { markdown?: unknown; projectId?: unknown };
  if (typeof body.markdown !== "string" || Buffer.byteLength(body.markdown, "utf8") > MAX_CONVERSATION_IMPORT_BYTES) {
    return NextResponse.json({ error: "A Rangabot Markdown export up to 2 MB is required." }, { status: 400 });
  }
  try {
    const messages = parseConversationMarkdown(body.markdown);
    const projectId = typeof body.projectId === "string" ? body.projectId : null;
    return NextResponse.json({ conversation: createConversation(messages, projectId) }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Conversation import failed." }, { status: 400 });
  }
}
