"use client";

import React, { useEffect, useState } from "react";
import QRCode from "qrcode";

interface QRCodeDisplayProps {
  value: string;
  size?: number;
  className?: string;
}

/**
 * Clean, standard ISO/IEC 18004 compliant QR code renderer.
 * Uses high-res DataURL image with fixed dimensions to guarantee
 * it NEVER overflows or covers surrounding UI elements.
 */
export const QRCodeDisplay: React.FC<QRCodeDisplayProps> = ({
  value,
  size = 135,
  className = "",
}) => {
  const [dataUrl, setDataUrl] = useState<string>("");

  useEffect(() => {
    if (!value) return;

    QRCode.toDataURL(value, {
      width: 400, // 400px internal raster for ultra-sharp optical clarity
      margin: 2,  // Clean white quiet zone
      errorCorrectionLevel: "M",
      color: {
        dark: "#000000", // Pure black for 100% contrast on mobile lenses
        light: "#FFFFFF",
      },
    })
      .then((url) => {
        setDataUrl(url);
      })
      .catch((err) => {
        console.error("Failed to generate QR code:", err);
      });
  }, [value]);

  return (
    <div
      style={{ width: `${size}px`, height: `${size}px`, maxWidth: `${size}px`, maxHeight: `${size}px` }}
      className={`relative p-2 bg-white rounded-2xl shadow-lg flex items-center justify-center border-2 border-[#DFAB6C] overflow-hidden flex-shrink-0 ${className}`}
    >
      {dataUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={dataUrl}
          alt={`Scan QR Code to Order: ${value}`}
          width={size - 16}
          height={size - 16}
          className="w-full h-full object-contain rounded-lg select-none block"
        />
      ) : (
        <div className="w-full h-full bg-neutral-100 rounded-lg animate-pulse" />
      )}
    </div>
  );
};
