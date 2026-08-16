import type { NextConfig } from "next";
import { requireKnownResponseFeedbackCandidate } from "./lib/response-feedback-candidate.ts";

const development = process.env.NODE_ENV !== "production";
const desktopStagingBuildId = process.env.RANGABOT_DESKTOP_STAGING_BUILD_ID;
const sourceBuildId = process.env.RANGABOT_SOURCE_BUILD_ID;
if (desktopStagingBuildId !== undefined && !/^desktop-stage-[0-9a-f]{16}$/.test(desktopStagingBuildId)) {
  throw new Error("RANGABOT_DESKTOP_STAGING_BUILD_ID is invalid.");
}
if (sourceBuildId !== undefined && !/^source-[0-9a-f]{24}$/.test(sourceBuildId)) {
  throw new Error("RANGABOT_SOURCE_BUILD_ID is invalid.");
}
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${development ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${development ? " ws://127.0.0.1:* ws://localhost:* ws://[::1]:*" : ""}`,
  "media-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  output: "standalone",
  // Turbopack's file tracer can conservatively retain source-only test files
  // reached while it analyzes dynamic private-root validation. Tests are never
  // runtime inputs and must not enter the packaged standalone application.
  outputFileTracingExcludes: {
    "/*": ["./tests/**/*"],
  },
  poweredByHeader: false,
  generateBuildId: async () => desktopStagingBuildId ?? sourceBuildId ?? requireKnownResponseFeedbackCandidate().build,
  serverExternalPackages: ["sqlite-vec", "@duckdb/node-api", "@duckdb/node-bindings"],
  async headers() {
    return [{
      source: "/(.*)",
      headers: [
        { key: "Content-Security-Policy", value: contentSecurityPolicy },
        { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-DNS-Prefetch-Control", value: "off" },
        { key: "X-Frame-Options", value: "DENY" },
      ],
    }];
  },
};

export default nextConfig;
