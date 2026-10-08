import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { Geist } from "next/font/google";
import { CORRELATION_ID_HEADER } from "@/lib/request-ids";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

// Publishes this page load's correlation id (minted by proxy.ts) as
// <meta name="correlation-id">, so browser requests can propagate it
// (lib/browser-api.ts). Reading headers() makes the layout dynamic.
export async function generateMetadata(): Promise<Metadata> {
  const correlationId = (await headers()).get(CORRELATION_ID_HEADER);
  return {
    title: { default: "Safe-Insurance", template: "%s | Safe-Insurance" },
    description: "Browse our insurance products and see what each one covers.",
    other: correlationId ? { "correlation-id": correlationId } : {},
  };
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={geistSans.variable}>
      <body>
        <header className="header">
          <div className="container">
            <Link href="/" className="brand">
              🛡️ Safe-Insurance
            </Link>
          </div>
        </header>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
