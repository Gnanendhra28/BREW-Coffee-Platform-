// Global Edge CDN & Dynamic Media Storage Utility
// Delivers automatic responsive formats (AVIF/WebP) and quality optimization (f_auto,q_auto)
// across Cloudinary, AWS S3 / CloudFront, or High-Performance Local Edge.

export type CdnProvider = "local" | "cloudinary" | "cloudfront";

export interface CdnImageOptions {
  width?: number;
  quality?: number | "auto";
  format?: "auto" | "webp" | "avif" | "png";
  crop?: "fill" | "fit" | "limit";
}

/**
 * Resolves the active CDN Provider from environment variables.
 */
export function getActiveCdnProvider(): CdnProvider {
  const provider = (process.env.NEXT_PUBLIC_CDN_PROVIDER || "").toLowerCase();
  if (provider === "cloudinary") return "cloudinary";
  if (provider === "cloudfront") return "cloudfront";
  return "local";
}

/**
 * Transforms an asset path into an optimized Cloudinary delivery URL with f_auto,q_auto.
 */
export function buildCloudinaryUrl(
  assetPath: string,
  options: CdnImageOptions = {}
): string {
  const cloudName = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME || "brew-sanctuary";
  const cleanPath = assetPath.replace(/^\/+/, "");

  const transformations: string[] = [];
  const fmt = options.format === "auto" || !options.format ? "f_auto" : `f_${options.format}`;
  const q = options.quality === "auto" || !options.quality ? "q_auto:good" : `q_${options.quality}`;

  transformations.push(fmt, q);

  if (options.width) {
    transformations.push(`w_${options.width}`);
  }
  if (options.crop) {
    transformations.push(`c_${options.crop}`);
  }

  const transformString = transformations.join(",");
  return `https://res.cloudinary.com/${cloudName}/image/upload/${transformString}/${cleanPath}`;
}

/**
 * Transforms an asset path into an AWS CloudFront CDN delivery URL.
 */
export function buildCloudFrontUrl(
  assetPath: string,
  options: CdnImageOptions = {}
): string {
  const domain = process.env.NEXT_PUBLIC_CLOUDFRONT_DOMAIN || "cdn.brew-coffee.cafe";
  const cleanPath = assetPath.replace(/^\/+/, "");
  const params = new URLSearchParams();

  if (options.width) params.set("width", options.width.toString());
  if (options.format) params.set("format", options.format);
  if (options.quality && options.quality !== "auto") {
    params.set("quality", options.quality.toString());
  }

  const query = params.toString() ? `?${params.toString()}` : "";
  return `https://${domain}/${cleanPath}${query}`;
}

/**
 * Resolves optimal asset URL depending on the configured CDN provider.
 * Automatically prefers WebP over legacy PNG when in local mode.
 */
export function getCdnImageUrl(
  src: string,
  options: CdnImageOptions = {}
): string {
  if (!src) return "/assets/cup1.webp";

  // Remote external URLs (like Google Auth avatars) are returned directly
  if (src.startsWith("http://") || src.startsWith("https://")) {
    return src;
  }

  const provider = getActiveCdnProvider();

  if (provider === "cloudinary") {
    return buildCloudinaryUrl(src, options);
  }

  if (provider === "cloudfront") {
    return buildCloudFrontUrl(src, options);
  }

  // Local fallback: auto-upgrade .png to .webp for 88%+ size reduction
  if (src.toLowerCase().endsWith(".png")) {
    return src.replace(/\.png$/i, ".webp");
  }

  return src;
}

/**
 * Custom Next.js Image Loader conforming to ImageLoaderProps.
 */
export function brewImageLoader({
  src,
  width,
  quality,
}: {
  src: string;
  width: number;
  quality?: number;
}): string {
  return getCdnImageUrl(src, {
    width,
    quality: quality || 80,
    format: "auto",
  });
}
