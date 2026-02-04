import type { Metadata } from "next";
import { Space_Grotesk, IBM_Plex_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const display = Space_Grotesk({
  variable: "--font-sans",
  subsets: ["latin"],
});

const mono = IBM_Plex_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "Voice Strategy Simulator",
  description: "Voice-driven strategy backtesting for SPY.",
};

const navLinks = [
  { href: "/", label: "Dashboard" },
  { href: "/scenarios", label: "Scenarios" },
  { href: "/prices", label: "Prices" },
  { href: "/voice", label: "Voice" },
  { href: "/runs", label: "Runs" },
  { href: "/settings", label: "Settings" },
];

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${display.variable} ${mono.variable} font-sans antialiased`}>
        <div className="min-h-screen bg-gradient-to-b from-zinc-50 via-white to-zinc-100">
          <header className="border-b border-zinc-200/80 bg-white/80 backdrop-blur">
            <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-4">
              <div className="text-sm font-semibold tracking-tight text-zinc-900">
                Voice Strategy Simulator
              </div>
              <nav className="flex flex-wrap gap-4 text-sm text-zinc-600">
                {navLinks.map((link) => (
                  <Link key={link.href} href={link.href} className="hover:text-zinc-900">
                    {link.label}
                  </Link>
                ))}
              </nav>
            </div>
          </header>
          <main className="mx-auto w-full max-w-6xl px-6 py-8">{children}</main>
        </div>
      </body>
    </html>
  );
}
