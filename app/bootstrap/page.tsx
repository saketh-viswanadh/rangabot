"use client";

import { useEffect, useRef, useState } from "react";
import { LOCAL_BOOTSTRAP_HEADER, LOCAL_BOOTSTRAP_PATH } from "@/lib/local-http-security";

type BootstrapState = "authorizing" | "missing" | "blocked";

export default function LocalBootstrapPage() {
  const started = useRef(false);
  const [state, setState] = useState<BootstrapState>("authorizing");

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const fragment = window.location.hash;
    const token = fragment.length <= 128
      ? new URLSearchParams(fragment.slice(1)).get("bootstrap")
      : null;
    window.history.replaceState(null, "", window.location.pathname);
    if (!token || !/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(token)) {
      queueMicrotask(() => setState("missing"));
      return;
    }

    const authorize = async () => {
      try {
        const response = await fetch(LOCAL_BOOTSTRAP_PATH, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [LOCAL_BOOTSTRAP_HEADER]: token,
          },
          body: "{}",
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!response.ok) {
          setState("blocked");
          return;
        }
        window.location.replace("/");
      } catch {
        setState("blocked");
      }
    };
    void authorize();
  }, []);

  const message = state === "authorizing"
    ? "Opening your private local session…"
    : state === "missing"
      ? "Use the private startup link printed by npm run dev."
      : "That startup link is invalid or belongs to an earlier Rangabot launch. Restart Rangabot and use the newly printed link.";

  return (
    <main style={{
      alignItems: "center",
      background: "#17130f",
      color: "#f5f0e8",
      display: "flex",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif",
      justifyContent: "center",
      minHeight: "100dvh",
      padding: "24px",
    }}>
      <section aria-live="polite" style={{ maxWidth: "460px", textAlign: "center" }}>
        <p style={{ color: "#e4b564", fontSize: "12px", fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase" }}>
          Rangabot · local only
        </p>
        <h1 style={{ fontSize: "clamp(28px, 6vw, 44px)", letterSpacing: "-.04em", margin: "12px 0" }}>
          Private session
        </h1>
        <p style={{ color: "#b9aea2", lineHeight: 1.6, margin: 0 }}>{message}</p>
      </section>
    </main>
  );
}
