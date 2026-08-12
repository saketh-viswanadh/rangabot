import { NextResponse } from "next/server";
import { LOCAL_PROFILE_CONTEXT_HEADER, LOCAL_SESSION_COOKIE } from "./local-http-security.ts";
import {
  issueLocalSessionToken,
  localProfileSessionContext,
  type LocalProfileSessionBinding,
} from "./local-session-token.ts";

export function bindResponseToProfileSession<T>(response: NextResponse<T>, binding: LocalProfileSessionBinding) {
  const secret = process.env.RANGABOT_SESSION_SECRET;
  if (!secret) throw new Error("Rangabot's local session authority is unavailable.");
  response.cookies.set({
    name: LOCAL_SESSION_COOKIE,
    value: issueLocalSessionToken(secret, binding),
    httpOnly: false,
    sameSite: "strict",
    secure: false,
    path: "/",
  });
  response.headers.set(LOCAL_PROFILE_CONTEXT_HEADER, localProfileSessionContext(binding));
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
