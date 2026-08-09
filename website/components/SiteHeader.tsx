import Image from "next/image";
import { ThemeToggle } from "./ThemeToggle";

const nav = [
  ["Charter", "/charter"],
  ["Product", "/product"],
  ["Mastery", "/mastery"],
  ["Evidence", "/evidence"],
  ["Docs", "/docs"],
  ["Community", "/community"],
] as const;

export function SiteHeader() {
  return (
    <header className="site-header">
      <a className="brand" href="/" aria-label="Rangabot home">
        <span className="brand-mark"><Image src="/ranga/ranga-idle.png" alt="" width={30} height={34} /></span>
        <span>Rangabot</span>
      </a>
      <nav className="desktop-nav" aria-label="Primary navigation">
        {nav.map(([label, href]) => <a href={href} key={href}>{label}</a>)}
      </nav>
      <div className="header-actions">
        <ThemeToggle />
        <a className="button button-small button-ink" href="/download">Get Rangabot</a>
        <details className="mobile-menu">
          <summary aria-label="Open navigation">Menu</summary>
          <nav aria-label="Mobile navigation">
            {nav.map(([label, href]) => <a href={href} key={href}>{label}</a>)}
            <a href="/showcase">Showcase</a>
            <a href="/privacy">Privacy</a>
            <a href="/download">Get Rangabot</a>
          </nav>
        </details>
      </div>
    </header>
  );
}
