import type { Metadata, Viewport } from "next";
import "./globals.css";
import { PwaProvider } from "@/components/PwaProvider";
import { themeScript } from "@/lib/theme";

export const metadata: Metadata = {
  title: "Crumb Club POS",
  description: "Point of sale for Crumb Club. Keeps selling when the internet drops.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Crumb Club POS", statusBarStyle: "default" },
  icons: { icon: "/icon.svg", apple: "/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  themeColor: "#9a4f12",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Sets light/dark before first paint (see src/lib/theme.ts). */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-dvh antialiased">
        <a href="#main" className="skip-link">Skip to content</a>
        <PwaProvider>{children}</PwaProvider>
      </body>
    </html>
  );
}
