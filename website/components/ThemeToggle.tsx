"use client";

import { useEffect } from "react";

type Theme = "light" | "dark";

export function ThemeToggle() {
  useEffect(() => {
    const saved = window.localStorage.getItem("rangabot-site-theme") as Theme | null;
    const preferred = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    const next = saved ?? preferred;
    document.documentElement.dataset.theme = next;
  }, []);

  function toggleTheme() {
    const next: Theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    window.localStorage.setItem("rangabot-site-theme", next);
  }

  return (
    <button className="theme-toggle" type="button" onClick={toggleTheme} aria-label="Toggle color theme">
      <span aria-hidden="true">◐</span>
    </button>
  );
}
