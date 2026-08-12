import { NextResponse } from "next/server";
import {
  DesktopPreferencesConflictError,
  DesktopPreferencesPayloadTooLargeError,
  importLegacyDesktopPreferences,
  readDesktopPreferencesMutation,
  readDesktopPreferences,
  updateDesktopPreferences,
} from "@/lib/desktop-preferences";

export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json({ preferences: readDesktopPreferences() });
  } catch {
    return NextResponse.json({ error: "Local desktop preferences could not be read safely." }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const body = await readDesktopPreferencesMutation(request);
    return NextResponse.json({ preferences: updateDesktopPreferences(body) });
  } catch (error) {
    if (error instanceof DesktopPreferencesPayloadTooLargeError) {
      return NextResponse.json({ error: error.message }, { status: 413 });
    }
    if (error instanceof DesktopPreferencesConflictError) {
      return NextResponse.json({ error: error.message, preferences: error.current }, { status: 409 });
    }
    return NextResponse.json({ error: "Desktop preferences were not changed." }, { status: 400 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await readDesktopPreferencesMutation(request, { requireConfirmedImport: true });
    return NextResponse.json(importLegacyDesktopPreferences(body));
  } catch (error) {
    if (error instanceof DesktopPreferencesPayloadTooLargeError) {
      return NextResponse.json({ error: error.message }, { status: 413 });
    }
    return NextResponse.json({ error: "Legacy preferences were not imported." }, { status: 400 });
  }
}
