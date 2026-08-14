import type { Metadata } from "next";
import { productConfig } from "@/lib/product-config";
import "./globals.css";

export const metadata: Metadata = {
  title: productConfig.name,
  description: productConfig.shortDescription,
  icons: {
    icon: [
      { url: "/brand/rangabot-primary-64.png", sizes: "64x64", type: "image/png" },
      { url: "/brand/rangabot-primary-192.png", sizes: "192x192", type: "image/png" },
    ],
    shortcut: "/brand/rangabot-primary-64.png",
    apple: [{ url: "/brand/rangabot-primary-192.png", sizes: "192x192", type: "image/png" }],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
