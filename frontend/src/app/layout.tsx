import type { Metadata, Viewport } from "next";

import { BRAND, DEFAULT_THEME_MODE } from "@/generated/brand";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: BRAND.productName,
    template: `%s · ${BRAND.productName}`,
  },
  description: BRAND.tagline,
  applicationName: BRAND.productName,
  authors: [{ name: BRAND.companyName }],
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: BRAND.theme.tokens[BRAND.theme.defaultMode].bgPrimary,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={DEFAULT_THEME_MODE === "dark" ? "dark" : undefined} suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
