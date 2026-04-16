import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hubcode",
  description: "Hubcode Authentication & Management",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body suppressHydrationWarning className="font-sans antialiased min-h-screen">
        {children}
      </body>
    </html>
  );
}
