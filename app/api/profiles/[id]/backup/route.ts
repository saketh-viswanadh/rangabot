import { NextResponse } from "next/server";
import { backupProfile } from "@/lib/profile-lifecycle";
import { assertProfileBackupExportAccess } from "@/lib/desktop-external-filesystem-policy";
import { profileBindingFromRequest } from "@/lib/profile-request";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const profileId = (await context.params).id;
    profileBindingFromRequest(request);
    assertProfileBackupExportAccess();
    const bytes = await backupProfile(profileId);
    return new NextResponse(Uint8Array.from(bytes).buffer, {
      headers: {
        "Content-Type": "application/vnd.rangabot.profile-backup+json",
        "Content-Disposition": "attachment; filename=RangaBot-profile-backup.json",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "The profile backup could not be created." }, { status: 409 }); }
}
