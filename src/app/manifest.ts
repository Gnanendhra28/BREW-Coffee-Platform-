import { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "BREW — Luxury Mobile Coffee Van",
    short_name: "BREW",
    description:
      "Luxury artisanal coffee outlet on wheels. Handcrafted espresso, single-origin pour-overs, imperial teas, and oven-baked desserts.",
    start_url: "/",
    display: "standalone",
    background_color: "#140D08",
    theme_color: "#DFAB6C",
    orientation: "portrait",
    icons: [
      {
        src: "/assets/spoon.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/assets/brew_logo_hd.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
    ],
  };
}
