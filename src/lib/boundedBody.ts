import { NextRequest, NextResponse } from "next/server";

export const MAX_REQUEST_SIZE_BYTES = 100 * 1024; // 100 KB strict limit

export interface BoundedReadResult<T = unknown> {
  ok: boolean;
  data?: T;
  rawText?: string;
  response?: NextResponse;
}

/**
 * Safely reads and enforces size limits on a NextRequest body stream.
 * 
 * Protects against:
 * - Content-Length header spoofing or omissions
 * - Chunked / streaming transfer-encoding memory exhaustion
 * - Excessive allocations before JSON parsing
 * 
 * Returns HTTP 413 if the payload exceeds maxBytes.
 * Returns HTTP 400 if the payload is empty or malformed JSON.
 */
export async function readBoundedJson<T = unknown>(
  req: NextRequest,
  maxBytes: number = MAX_REQUEST_SIZE_BYTES
): Promise<BoundedReadResult<T>> {
  // 1. Fast path: check Content-Length header if present
  const contentLength = req.headers.get("content-length");
  if (contentLength) {
    const parsedLength = parseInt(contentLength, 10);
    if (!isNaN(parsedLength) && parsedLength > maxBytes) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: "Payload too large. Maximum request size is 100KB." },
          { status: 413 }
        ),
      };
    }
  }

  // 2. Stream-bounded reading: handles missing Content-Length and chunked transfer
  if (!req.body) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Empty request body" }, { status: 400 }),
    };
  }

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.length;
        if (totalBytes > maxBytes) {
          try {
            await reader.cancel();
          } catch {
            // Ignore cancel errors
          }
          return {
            ok: false,
            response: NextResponse.json(
              { error: "Payload too large. Maximum request size is 100KB." },
              { status: 413 }
            ),
          };
        }
        chunks.push(value);
      }
    }
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Payload too large or stream read failed" },
        { status: 413 }
      ),
    };
  }

  if (totalBytes === 0) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Empty request body" }, { status: 400 }),
    };
  }

  const rawText = Buffer.concat(chunks).toString("utf8");
  try {
    const data = JSON.parse(rawText) as T;
    return { ok: true, data, rawText };
  } catch {
    return {
      ok: false,
      rawText,
      response: NextResponse.json({ error: "Malformed JSON payload" }, { status: 400 }),
    };
  }
}

/**
 * Safely reads raw text from a NextRequest body stream while enforcing max byte limits.
 * Ideal for webhooks requiring raw cryptographic signature validation.
 */
export async function readBoundedText(
  req: NextRequest,
  maxBytes: number = MAX_REQUEST_SIZE_BYTES
): Promise<BoundedReadResult<string>> {
  const contentLength = req.headers.get("content-length");
  if (contentLength) {
    const parsedLength = parseInt(contentLength, 10);
    if (!isNaN(parsedLength) && parsedLength > maxBytes) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: "Payload too large. Maximum request size is 100KB." },
          { status: 413 }
        ),
      };
    }
  }

  if (!req.body) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Empty request body" }, { status: 400 }),
    };
  }

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.length;
        if (totalBytes > maxBytes) {
          try {
            await reader.cancel();
          } catch {
            // Ignore cancel errors
          }
          return {
            ok: false,
            response: NextResponse.json(
              { error: "Payload too large. Maximum request size is 100KB." },
              { status: 413 }
            ),
          };
        }
        chunks.push(value);
      }
    }
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Payload too large or stream read failed" },
        { status: 413 }
      ),
    };
  }

  if (totalBytes === 0) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Empty request body" }, { status: 400 }),
    };
  }

  const rawText = Buffer.concat(chunks).toString("utf8");
  return { ok: true, data: rawText, rawText };
}
