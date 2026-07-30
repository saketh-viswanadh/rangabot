import { exportMemoriesJson } from "@/lib/memories";

export const runtime = "nodejs";

export async function GET() {
  return new Response(exportMemoriesJson(), {
    headers: {
      "Cache-Control": "no-store",
      "Content-Disposition": 'attachment; filename="rangabot-memories.json"',
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}
