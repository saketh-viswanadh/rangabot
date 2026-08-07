import { buildBookWelcomeResponse } from "@/lib/knowledge-welcome";

export const runtime = "nodejs";

export function GET(request: Request) {
  return buildBookWelcomeResponse(request);
}
