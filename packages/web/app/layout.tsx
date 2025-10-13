import type { Metadata } from "next";
import "./globals.css";
import AuthGate from "./components/auth-gate";

export const metadata: Metadata = {
  title: "Real-Time Voice",
  description: "Real-time voice interaction with OpenAI",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <AuthGate>{children}</AuthGate>
      </body>
    </html>
  );
}
