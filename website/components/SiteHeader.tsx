import Link from "next/link";
import Image from "next/image";
import { ThemeToggle } from "./ThemeToggle";

const nav = [
  ["Product", "/product"],
  ["Mastery", "/mastery"],
  ["Evidence", "/evidence"],
  ["Docs", "/docs"],
  ["Community", "/community"],
] as const;

export function SiteHeader() {
  return (
    <header className="site-header">
      <Link className="brand" href="/" aria-label="Rangabot home">
        <span className="brand-mark"><Image src="/ranga/ranga-idle.png" alt="" width={30} height={34} /></span>
        <span>Rangabot</span>
      </Link>
      <nav className="desktop-nav" aria-label="Primary navigation">
        {nav.map(([label, href]) => <Link href={href} key={href}>{label}</Link>)}
      </nav>
      <div className="header-actions">
        <ThemeToggle />
        <Link className="button button-small button-ink" href="/download">Get Rangabot</Link>
        <details className="mobile-menu">
          <summary aria-label="Open navigation">Menu</summary>
          <nav aria-label="Mobile navigation">
            {nav.map(([label, href]) => <Link href={href} key={href}>{label}</Link>)}
            <Link href="/showcase">Showcase</Link>
            <Link href="/privacy">Privacy</Link>
            <Link href="/download">Get Rangabot</Link>
          </nav>
        </details>
      </div>
    </header>
  );
}
