import { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://brew-coffee.cafe";

  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/menu", "/location", "/board", "/cart"],
        disallow: ["/barista", "/order-status/*", "/api/*"],
      },
    ],
    sitemap: `${baseUrl}/sitemap.xml`,
  };
}
