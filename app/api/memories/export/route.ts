import { exportMemoriesJson } from "@/lib/memories";
import { StaleProfileRequestError, withProfileRequest } from "@/lib/profile-request";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    return await withProfileRequest(request, { kind: "export", label: "memory export" }, () => (
      new Response(exportMemoriesJson(), {
        headers: {
          "Cache-Control": "no-store",
          "Content-Disposition": 'attachment; filename="rangabot-memories.json"',
          "Content-Type": "application/json; charset=utf-8",
        },
      })
    ));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Memories could not be exported." }, { status: error instanceof StaleProfileRequestError ? 409 : 500 });
  }
}
