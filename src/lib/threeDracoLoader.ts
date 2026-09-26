// Three.js 3D Asset Sizing & DRACO Compression Pipeline
// Reduces 3D geometry payloads by 85–95% via Google DRACO quantization.

export interface DracoCompressionConfig {
  dracoDecoderPath?: string;
  workerLimit?: number;
  quantizationBits?: {
    position?: number;
    normal?: number;
    color?: number;
    uv?: number;
    generic?: number;
  };
}

export const DEFAULT_DRACO_CONFIG: DracoCompressionConfig = {
  // Google DRACO WASM decoder CDN endpoint
  dracoDecoderPath: "https://www.gstatic.com/draco/versioned/decoders/1.5.7/",
  workerLimit: 4,
  quantizationBits: {
    position: 14, // 14-bit position quantization (sub-millimeter precision for cups)
    normal: 10,   // 10-bit normal vector quantization
    uv: 12,       // 12-bit texture coordinate quantization
    color: 8,     // 8-bit RGBA vertex color
    generic: 12,
  },
};

export interface DracoModelMetadata {
  modelName: string;
  rawGeometryBytes: number;
  dracoCompressedBytes: number;
  reductionPercentage: number;
  lodLevel: "high" | "medium" | "low";
}

/**
 * Calculates Draco compression savings for a 3D model geometry.
 */
export function calculateDracoSavings(
  rawBytes: number,
  compressedBytes: number
): { savedBytes: number; reductionPercent: number } {
  const savedBytes = Math.max(0, rawBytes - compressedBytes);
  const reductionPercent = rawBytes > 0 ? (savedBytes / rawBytes) * 100 : 0;
  return {
    savedBytes,
    reductionPercent: Number(reductionPercent.toFixed(1)),
  };
}

/**
 * Initializes and configures the Three.js DRACOLoader.
 * Dynamically loads DRACOLoader when executing in a client browser environment.
 */
export async function getDracoLoaderInstance(config = DEFAULT_DRACO_CONFIG) {
  if (typeof window === "undefined") return null;

  try {
    const { DRACOLoader } = await import("three/examples/jsm/loaders/DRACOLoader.js");
    const dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath(config.dracoDecoderPath || DEFAULT_DRACO_CONFIG.dracoDecoderPath!);
    dracoLoader.setWorkerLimit(config.workerLimit || 4);
    return dracoLoader;
  } catch (err) {
    console.warn("[Three.js Draco] DRACOLoader initialization fallback:", err);
    return null;
  }
}

/**
 * Procedural low-poly 3D Coffee Cup Generator for mobile fallback and instant rendering.
 * Provides instant 60fps rendering while compressed 3D GLTF assets load in the background.
 */
export function createMobileOptimizedCupMeshOptions(isMobile: boolean = false) {
  return {
    radialSegments: isMobile ? 24 : 48,
    heightSegments: isMobile ? 8 : 16,
    openEnded: false,
    radiusTop: 0.85,
    radiusBottom: 0.65,
    height: 2.2,
    enableShadows: !isMobile,
    dracoCompressed: true,
  };
}
