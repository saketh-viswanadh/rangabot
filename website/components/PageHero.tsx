import type { ReactNode } from "react";

export function PageHero({ eyebrow, title, description, children, compact = false }: { eyebrow: string; title: string; description: string; children?: ReactNode; compact?: boolean }) {
  return (
    <section className={`page-hero${compact ? " page-hero-compact" : ""}`}>
      <span className="eyebrow">{eyebrow}</span>
      <h1>{title}</h1>
      <p>{description}</p>
      {children && <div className="hero-actions">{children}</div>}
    </section>
  );
}
