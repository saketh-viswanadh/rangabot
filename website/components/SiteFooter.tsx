import Image from "next/image";
import { footerGroups } from "../lib/site-content";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="footer-signature">
        <span className="brand-mark"><Image src="/ranga/ranga-idle.png" alt="" width={43} height={48} /></span>
        <div><strong>Rangabot</strong><p>A loyal local assistant, crafted in the open.</p></div>
      </div>
      <div className="footer-links">
        {footerGroups.map((group) => (
          <div key={group.title}><strong>{group.title}</strong>{group.links.map(([label, href]) => <a key={href} href={href}>{label}</a>)}</div>
        ))}
      </div>
      <div className="footer-base">
        <span>Open source · Local first · Pre-release</span>
        <span>Chats, memories and private documents are never website content.</span>
      </div>
    </footer>
  );
}
