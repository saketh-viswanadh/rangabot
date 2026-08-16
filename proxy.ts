import { NextRequest, NextResponse } from "next/server";
import {
  bindLocalRequestUrlToValidatedHost,
  evaluateLocalBootstrapRequest,
  evaluateLocalApiRequest,
  isAllowedLoopbackHost,
  LOCAL_BOOTSTRAP_HEADER,
  LOCAL_BOOTSTRAP_PATH,
  LOCAL_PROFILE_CONTEXT_HEADER,
  LOCAL_SESSION_COOKIE,
} from "./lib/local-http-security";
import {
  createExpectedLocalBootstrapTokenVerifier,
  createLocalSessionSecret,
  issueLocalSessionToken,
  verifyLocalSessionToken,
  localProfileSessionContext,
} from "./lib/local-session-token";
import { recoveryProfileSessionBindings, sessionBindingForLocalGate } from "./lib/profile-context";
import {
  DESKTOP_READINESS_PROCESS_HEADER,
  DESKTOP_READINESS_PROOF_HEADER,
  DESKTOP_READINESS_PATH,
  evaluateDesktopReadinessRequest,
  issueDesktopReadinessProof,
} from "./lib/desktop-startup-security";

const sessionSecret = process.env.RANGABOT_SESSION_SECRET || createLocalSessionSecret();
const expectedBootstrapToken = process.env.RANGABOT_BOOTSTRAP_TOKEN;
const bootstrapTokenVerifier = createExpectedLocalBootstrapTokenVerifier({
  secret: sessionSecret,
  expectedToken: expectedBootstrapToken,
  consumeOnce: process.env.RANGABOT_DESKTOP === "1",
});

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
  const host = request.headers.get("host");
  if (!isAllowedLoopbackHost(host)) return forbidden(api);
  const requestUrl = bindLocalRequestUrlToValidatedHost(request.url, host);
  if (!requestUrl) return forbidden(api);

  if (request.nextUrl.pathname === DESKTOP_READINESS_PATH) {
    const valid = evaluateDesktopReadinessRequest({
      desktopMode: process.env.RANGABOT_DESKTOP === "1",
      expectedChallenge: process.env.RANGABOT_DESKTOP_READINESS_CHALLENGE,
      port: process.env.PORT,
      url: requestUrl,
      method: request.method,
      headers: request.headers,
    });
    const secret = process.env.RANGABOT_DESKTOP_READINESS_SECRET;
    if (!valid || typeof secret !== "string") return forbidden(true);
    let proof: string;
    try {
      proof = issueDesktopReadinessProof({
        challenge: process.env.RANGABOT_DESKTOP_READINESS_CHALLENGE ?? "",
        secret,
        processId: process.pid,
      });
    } catch {
      return forbidden(true);
    }
    const response = new NextResponse(null, { status: 204 });
    response.headers.set(DESKTOP_READINESS_PROCESS_HEADER, String(process.pid));
    response.headers.set(DESKTOP_READINESS_PROOF_HEADER, proof);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }

  if (request.nextUrl.pathname === LOCAL_BOOTSTRAP_PATH) {
    const suppliedBootstrapToken = request.headers.get(LOCAL_BOOTSTRAP_HEADER) ?? undefined;
    const result = evaluateLocalBootstrapRequest({
      url: requestUrl,
      method: request.method,
      headers: request.headers,
      bootstrapTokenValid: bootstrapTokenVerifier.matches(suppliedBootstrapToken),
    });
    if (!result.ok) return forbidden(true, result.status);
    if (!bootstrapTokenVerifier.consume(suppliedBootstrapToken)) return forbidden(true);
    let binding;
    try { binding = sessionBindingForLocalGate(); }
    catch { return forbidden(true); }
    const response = new NextResponse(null, { status: 204 });
    response.cookies.set({
      name: LOCAL_SESSION_COOKIE,
      value: issueLocalSessionToken(sessionSecret, binding),
      httpOnly: false,
      sameSite: "strict",
      secure: false,
      path: "/",
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  }

  if (api) {
    const recoveryBindings = (() => {
      try { return recoveryProfileSessionBindings(); }
      catch { return []; }
    })();
    if (recoveryBindings.length > 0) {
      const recoveryRead = request.nextUrl.pathname === "/api/profiles" && request.method === "GET";
      const recoveryMutation = request.nextUrl.pathname === "/api/profiles/recover" && request.method === "POST";
      if (!recoveryRead && !recoveryMutation) return forbidden(true);
    }
    const sessionCookie = request.cookies.get(LOCAL_SESSION_COOKIE)?.value;
    let bindings;
    try { bindings = recoveryBindings.length > 0 ? recoveryBindings : [sessionBindingForLocalGate()]; }
    catch { return forbidden(true); }
    const suppliedProfileContext = request.headers.get(LOCAL_PROFILE_CONTEXT_HEADER);
    const binding = bindings.find((candidate) => suppliedProfileContext === localProfileSessionContext(candidate));
    if (!binding) return forbidden(true);
    const result = evaluateLocalApiRequest({
      url: requestUrl,
      method: request.method,
      headers: request.headers,
      sessionCookie,
      issuedSessionValid: verifyLocalSessionToken(sessionCookie, sessionSecret, binding),
      profileContextValid: suppliedProfileContext === localProfileSessionContext(binding),
    });
    if (!result.ok) return forbidden(true, result.status);
    const response = NextResponse.next();
    response.headers.set("Cache-Control", "no-store");
    return response;
  }

  const current = request.cookies.get(LOCAL_SESSION_COOKIE)?.value;
  let binding;
  try { binding = sessionBindingForLocalGate(); }
  catch { return forbidden(false); }
  const sessionValid = verifyLocalSessionToken(current, sessionSecret, binding);
  if (request.nextUrl.pathname === "/bootstrap") {
    if (sessionValid) return NextResponse.redirect(new URL("/", requestUrl), 303);
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
