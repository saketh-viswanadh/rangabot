import type { Metadata } from "next";
import { productConfig } from "@/lib/product-config";
import "./globals.css";

export const metadata: Metadata = {
  title: productConfig.name,
  description: productConfig.shortDescription,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
