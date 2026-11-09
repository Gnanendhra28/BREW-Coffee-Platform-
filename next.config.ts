import path from "node:path";
import type { NextConfig } from "next";
import { PHASE_PRODUCTION_SERVER } from "next/constants";

export default function nextConfig(phase: string): NextConfig {
  const isProdServer = phase === PHASE_PRODUCTION_SERVER;
  const isCiOrTest = process.env.CI === "true" || process.env.BREW_TEST_SUITE === "true";

  const rawBackendUrl = process.env.FASTAPI_BACKEND_URL;
  if (isProdServer && process.env.REQUIRE_FASTAPI_BACKEND === "true" && !rawBackendUrl && !isCiOrTest) {
    throw new Error(
      "[CONFIGURATION ERROR] FASTAPI_BACKEND_URL environment variable is strictly required in production runtime. Localhost fallbacks are prohibited."
    );
  }

  const FASTAPI_URL = rawBackendUrl ? rawBackendUrl.replace(/\/+$/, "") : "";

  return {
    output: "standalone",
    reactStrictMode: true,
    typescript: {
      ignoreBuildErrors: false,
    },
    webpack: (config) => {
      config.resolve = config.resolve || {};
      config.resolve.alias = config.resolve.alias || {};
      config.resolve.alias["@"] = path.resolve(process.cwd(), "src");
      return config;
    },
    async rewrites() {
      if (!FASTAPI_URL) {
        return { beforeFiles: [], afterFiles: [], fallback: [] };
      }
      return {
        beforeFiles: [
          {
            source: "/api/:path*",
            destination: `${FASTAPI_URL}/api/:path*`,
          },
        ],
        afterFiles: [],
        fallback: [],
      };
    },
    images: {
      formats: ["image/avif", "image/webp"],
      deviceSizes: [360, 480, 640, 750, 828, 1080, 1200, 1920],
      imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
      minimumCacheTTL: 31536000, // 1 year cache header for CDN edge caching
      remotePatterns: [
        {
          protocol: "https",
          hostname: "lh3.googleusercontent.com",
        },
        {
          protocol: "https",
          hostname: "firebasestorage.googleapis.com",
        },
        {
          protocol: "https",
          hostname: "res.cloudinary.com",
        },
        {
          protocol: "https",
          hostname: "**.cloudfront.net",
        },
        {
          protocol: "https",
          hostname: "**.s3.amazonaws.com",
        },
      ],
    },
    async headers() {
      return [
        {
          source: "/assets/:path*",
          headers: [
            {
              key: "Cache-Control",
              value: "public, max-age=31536000, immutable",
            },
          ],
        },
        {
          source: "/(.*)",
          headers: [
            {
              key: "X-Content-Type-Options",
              value: "nosniff",
            },
            {
              key: "X-Frame-Options",
              value: "SAMEORIGIN",
            },
            {
              key: "Referrer-Policy",
              value: "strict-origin-when-cross-origin",
            },
            {
              key: "Permissions-Policy",
              value: "camera=(), microphone=(self), geolocation=(self)",
            },
          ],
        },
      ];
    },
  };
}
