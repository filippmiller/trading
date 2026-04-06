import type { Metadata } from "next";
import { Space_Grotesk, IBM_Plex_Mono } from "next/font/google";
import { AppShell } from "@/components/AppShell";
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
  title: "QuantSurveillance | Digital City",
  description: "High-resolution market surveillance and hypothesis testing.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${display.variable} ${mono.variable} font-sans antialiased text-zinc-900`}>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
