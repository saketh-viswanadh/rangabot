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
  const image = new URL("/og-charter.png", metadataBase).toString();

  return {
    metadataBase,
    title: { default: "Rangabot — extraordinary capability from ordinary machines", template: "%s · Rangabot" },
    description: "An open, local-first personal intelligence system helping open models reach their full practical potential on everyday computers.",
    icons: { icon: "/ranga/ranga-idle.png", shortcut: "/ranga/ranga-idle.png" },
    openGraph: { title: "Rangabot — extraordinary capability from ordinary machines", description: "Your machine. Your models. Their full potential.", type: "website", images: [{ url: image, width: 1200, height: 630, alt: "Rangabot — your machine, your models, their full potential" }] },
    twitter: { card: "summary_large_image", title: "Rangabot — extraordinary capability from ordinary machines", description: "Open source, local first and evidence backed.", images: [image] },
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
