import type { Metadata } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono, Cormorant_Garamond } from "next/font/google";
import "./globals.css";
import { SiteHeader } from "../components/SiteHeader";
import { SiteFooter } from "../components/SiteFooter";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const editorial = Cormorant_Garamond({
  variable: "--font-editorial",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const rawHost = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const host = /^[a-z0-9.-]+(?::\d+)?$/i.test(rawHost) ? rawHost : "localhost:3000";
  const forwardedProtocol = requestHeaders.get("x-forwarded-proto");
  const protocol = forwardedProtocol === "http" || forwardedProtocol === "https" ? forwardedProtocol : host.startsWith("localhost") ? "http" : "https";
  const metadataBase = new URL(`${protocol}://${host}`);
  const image = new URL("/og.png", metadataBase).toString();

  return {
    metadataBase,
    title: { default: "Rangabot — private AI, faithfully local", template: "%s · Rangabot" },
    description: "A beautiful local-first assistant for private conversation, memory, teaching, analysis and creation.",
    icons: { icon: "/ranga/ranga-idle.png", shortcut: "/ranga/ranga-idle.png" },
    openGraph: { title: "Rangabot — private AI, faithfully local", description: "A loyal local assistant grounded in your knowledge, with evidence for every capability claim.", type: "website", images: [{ url: image, width: 1200, height: 630, alt: "Rangabot — Private AI, faithfully local" }] },
    twitter: { card: "summary_large_image", title: "Rangabot — private AI, faithfully local", description: "Open source, local first and evidence backed.", images: [image] },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${editorial.variable}`}
      >
        <SiteHeader />
        <main>{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
