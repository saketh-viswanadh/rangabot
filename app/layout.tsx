import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Rangabot",
  description: "A private, local-first coding and brainstorming assistant",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
