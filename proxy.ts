import { NextRequest, NextResponse } from "next/server";
import {
  evaluateLocalBootstrapRequest,
  evaluateLocalApiRequest,
  isAllowedLoopbackHost,
  LOCAL_BOOTSTRAP_HEADER,
  LOCAL_BOOTSTRAP_PATH,
  LOCAL_SESSION_COOKIE,
} from "./lib/local-http-security";
import {
  createLocalSessionSecret,
  issueLocalSessionToken,
  verifyExpectedLocalBootstrapToken,
  verifyLocalSessionToken,
} from "./lib/local-session-token";

const sessionSecret = process.env.RANGABOT_SESSION_SECRET || createLocalSessionSecret();
const expectedBootstrapToken = process.env.RANGABOT_BOOTSTRAP_TOKEN;

function forbidden(api: boolean, status: 403 | 411 | 413 | 415 = 403) {
  const error = status === 411 ? "Rangabot requires a bounded local request body."
    : status === 413 ? "That local request is too large."
      : status === 415 ? "Rangabot only accepts uncompressed local JSON requests."
        : "This private local request was blocked.";
  const response = api
    ? NextResponse.json({ error }, { status })
    : new NextResponse("Rangabot requires the private startup link printed by npm run dev.", { status: 403 });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export function proxy(request: NextRequest) {
  const api = request.nextUrl.pathname.startsWith("/api/");
  if (!isAllowedLoopbackHost(request.headers.get("host"))) return forbidden(api);

  if (request.nextUrl.pathname === LOCAL_BOOTSTRAP_PATH) {
    const suppliedBootstrapToken = request.headers.get(LOCAL_BOOTSTRAP_HEADER) ?? undefined;
    const result = evaluateLocalBootstrapRequest({
      url: request.url,
      method: request.method,
      headers: request.headers,
      bootstrapTokenValid: verifyExpectedLocalBootstrapToken(
        suppliedBootstrapToken,
        sessionSecret,
        expectedBootstrapToken,
      ),
    });
    if (!result.ok) return forbidden(true, result.status);
    const response = new NextResponse(null, { status: 204 });
    response.cookies.set({
      name: LOCAL_SESSION_COOKIE,
      value: issueLocalSessionToken(sessionSecret),
      httpOnly: false,
      sameSite: "strict",
      secure: false,
      path: "/",
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  }

  if (api) {
    const sessionCookie = request.cookies.get(LOCAL_SESSION_COOKIE)?.value;
    const result = evaluateLocalApiRequest({
      url: request.url,
      method: request.method,
      headers: request.headers,
      sessionCookie,
      issuedSessionValid: verifyLocalSessionToken(sessionCookie, sessionSecret),
    });
    if (!result.ok) return forbidden(true, result.status);
    const response = NextResponse.next();
    response.headers.set("Cache-Control", "no-store");
    return response;
  }

  const current = request.cookies.get(LOCAL_SESSION_COOKIE)?.value;
  const sessionValid = verifyLocalSessionToken(current, sessionSecret);
  if (request.nextUrl.pathname === "/bootstrap") {
    if (sessionValid) return NextResponse.redirect(new URL("/", request.url), 303);
    const response = NextResponse.next();
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
  if (!sessionValid) return forbidden(false);
  const response = NextResponse.next();
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export const config = {
  matcher: ["/api/:path*", "/", "/bootstrap", "/mastery/:path*"],
};
