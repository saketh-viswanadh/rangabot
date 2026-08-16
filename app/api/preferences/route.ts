import { NextResponse } from "next/server";
import {
  DesktopPreferencesConflictError,
  DesktopPreferencesPayloadTooLargeError,
  importLegacyDesktopPreferences,
  readDesktopPreferencesMutation,
  readDesktopPreferences,
  updateDesktopPreferences,
} from "@/lib/desktop-preferences";
import { assertProfileAcceptsExternalUserData, profileBindingFromRequest, StaleProfileRequestError, withProfileRequest } from "@/lib/profile-request";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    profileBindingFromRequest(request);
    return NextResponse.json({ preferences: readDesktopPreferences() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof StaleProfileRequestError ? error.message : "Local desktop preferences could not be read safely." }, { status: error instanceof StaleProfileRequestError ? 409 : 500 });
  }
}

export async function PUT(request: Request) {
  try {
    return await withProfileRequest(request, { kind: "database-mutation", label: "preference update" }, async () => {
      const body = await readDesktopPreferencesMutation(request);
      return NextResponse.json({ preferences: updateDesktopPreferences(body) });
    });
  } catch (error) {
    if (error instanceof DesktopPreferencesPayloadTooLargeError) {
      return NextResponse.json({ error: error.message }, { status: 413 });
    }
    if (error instanceof DesktopPreferencesConflictError) {
      return NextResponse.json({ error: error.message, preferences: error.current }, { status: 409 });
    }
    return NextResponse.json({ error: error instanceof StaleProfileRequestError ? error.message : "Desktop preferences were not changed." }, { status: error instanceof StaleProfileRequestError ? 409 : 400 });
  }
}

export async function POST(request: Request) {
  try {
    return await withProfileRequest(request, { kind: "import", label: "legacy preference import" }, async () => {
      assertProfileAcceptsExternalUserData();
      const body = await readDesktopPreferencesMutation(request, { requireConfirmedImport: true });
      return NextResponse.json(importLegacyDesktopPreferences(body));
    });
  } catch (error) {
    if (error instanceof DesktopPreferencesPayloadTooLargeError) {
      return NextResponse.json({ error: error.message }, { status: 413 });
    }
    return NextResponse.json({ error: error instanceof StaleProfileRequestError ? error.message : "Legacy preferences were not imported." }, { status: error instanceof StaleProfileRequestError ? 409 : 400 });
  }
}
