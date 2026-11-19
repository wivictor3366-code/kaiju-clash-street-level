import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "KAIJU CLASH — Street Level",
  description: "Pixel-art kaiju fighting game seen from the street: Godzilla vs King Ghidorah, destructible city, rollback-netcode PvP.",
};

export const viewport: Viewport = { themeColor: "#000000", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-black text-orange-50 antialiased">{children}</body>
    </html>
  );
}
