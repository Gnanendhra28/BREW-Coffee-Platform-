import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AuthProvider } from "@/context/AuthContext";
import { CartProvider } from "@/context/CartContext";
import { VanProvider } from "@/context/VanContext";
import { AuthModal } from "@/components/AuthModal";
import { BaristaChatbot } from "@/components/BaristaChatbot";
import { FlashDealBanner } from "@/components/FlashDealBanner";

export const viewport: Viewport = {
  themeColor: "#140D08",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
};

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "https://brew-coffee.cafe"),
  title: {
    default: "BREW — Artisanal Mobile Coffee Van | Outlet on Wheels",
    template: "%s | BREW Mobile Coffee",
  },
  description:
    "BREW is a luxury artisanal coffee outlet on wheels. Slow-roasted single-origin espresso, imperial loose-leaf teas, handcrafted shakes, and fresh bakery treats served street-side and curbside.",
  keywords: [
    "BREW",
    "coffee van",
    "coffee truck",
    "mobile espresso bar",
    "specialty coffee",
    "curbside coffee pickup",
    "outdoor digital coffee board",
    "handcrafted espresso",
  ],
  authors: [{ name: "BREW Coffee Co." }],
  creator: "BREW Coffee Co.",
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "https://brew-coffee.cafe",
    siteName: "BREW Mobile Coffee Van",
    title: "BREW — Artisanal Mobile Coffee Van | Outlet on Wheels",
    description:
      "Handcrafted specialty coffee, teas, shakes, and bakery treats served hot from our mobile coffee van.",
    images: [
      {
        url: "/assets/spoon.png",
        width: 1200,
        height: 630,
        alt: "BREW Coffee Van Emblem",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "BREW — Artisanal Mobile Coffee Van",
    description:
      "Luxury mobile coffee van and kitchen display. Track the van, order street-side, and collect via live buzzer.",
    images: ["/assets/spoon.png"],
    creator: "@brew_coffee",
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  icons: {
    icon: "/assets/spoon.png",
    shortcut: "/assets/spoon.png",
    apple: "/assets/spoon.png",
  },
  manifest: "/manifest.webmanifest",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="bg-[#1A110B] text-[#F4EFE6] font-sans min-h-screen antialiased selection:bg-[#8C7C70]/30 selection:text-white">
        <AuthProvider>
          <CartProvider>
            <VanProvider>
              <FlashDealBanner />
              {children}
              <AuthModal />
              <BaristaChatbot />
            </VanProvider>
          </CartProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
