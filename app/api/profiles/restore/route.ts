import { NextResponse } from "next/server";
import { inspectProfileBackup, PROFILE_BACKUP_MAX_BYTES } from "@/lib/profile-backup";
import { assertExternalImportAccess } from "@/lib/desktop-external-filesystem-policy";
import { restoreProfile } from "@/lib/profile-lifecycle";
import { currentProfileSessionBinding, profileStatusDto } from "@/lib/profile-context";
import { bindResponseToProfileSession } from "@/lib/profile-session-response";
import { profileBindingFromRequest } from "@/lib/profile-request";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    profileBindingFromRequest(request);
    assertExternalImportAccess("profile-backup-import");
    const expected = request.headers.get("X-Rangabot-Profile-Generation");
    if (!expected || !/^[1-9][0-9]{0,15}$/.test(expected)) throw new Error("A valid profile generation is required.");
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (!bytes.byteLength || bytes.byteLength > PROFILE_BACKUP_MAX_BYTES) throw new Error("The profile backup exceeds the local size limit.");
    profileBindingFromRequest(request);
    const inspected = inspectProfileBackup(bytes);
    const displayName = `${inspected.sourceProfile.displayName} restored`.normalize("NFC").slice(0, 64).trim();
    const result = restoreProfile({ bytes, displayName, kind: "personal", expectedGeneration: Number(expected) });
    return bindResponseToProfileSession(NextResponse.json({ profile: result.profile, profiles: profileStatusDto() }, { status: 201 }), currentProfileSessionBinding());
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "The profile backup was not restored." }, { status: 409 }); }
}
