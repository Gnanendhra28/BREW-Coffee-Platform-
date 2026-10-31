import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  broadcastRealtimeEvent,
  ServerRealtimeEvent,
} from "@/lib/serverRealtimeStore";
import { verifySessionToken } from "@/lib/authTokens";
import { isSessionRevoked } from "@/lib/sessionRevocation";
import { checkRateLimit, getClientIp } from "@/lib/rateLimit";
import { maskPhone } from "@/lib/observability/logger";

export const dynamic = "force-dynamic";

// Strict Whitelist of Allowed Event Types
const ALLOWED_EVENT_TYPES = [
  "ORDER_CREATED",
  "ORDER_STATUS_CHANGED",
  "INVENTORY_CHANGED",
  "LOCATION_CHANGED",
  "FUTURE_STOPS_CHANGED",
  "CURBSIDE_SIGNAL",
  "FLASH_DEAL_CHANGED",
] as const;

type AllowedEventType = (typeof ALLOWED_EVENT_TYPES)[number];

const STAFF_ONLY_EVENT_TYPES: Set<AllowedEventType> = new Set([
  "ORDER_STATUS_CHANGED",
  "INVENTORY_CHANGED",
  "LOCATION_CHANGED",
  "FUTURE_STOPS_CHANGED",
  "FLASH_DEAL_CHANGED",
]);

// Zod Schemas for Event Payloads
const OrderCreatedPayloadSchema = z.object({
  id: z.string().min(1, "Order ID is required"),
  orderNumber: z.string().min(1, "Order Number is required"),
  customerName: z.string().min(1, "Customer Name is required"),
  customerPhone: z.string().optional(),
  items: z.array(z.any()).min(1, "At least 1 item is required"),
  totalAmount: z.number().nonnegative("Total amount must be non-negative"),
  status: z.enum(["pending", "received", "brewing", "ready", "completed", "cancelled"]).default("pending"),
  pickupType: z.enum(["walkup", "curbside"]).default("walkup"),
  vanLocationName: z.string().optional(),
  notes: z.string().max(500).optional(),
  vehicleInfo: z.string().max(200).optional(),
  createdAt: z.number().optional(),
  paymentStatus: z.string().optional(),
  paymentMethod: z.string().optional(),
});

const OrderStatusChangedPayloadSchema = z.object({
  orderId: z.string().min(1, "orderId is required"),
  status: z.enum(["pending", "brewing", "ready", "completed", "cancelled"]),
  orderNumber: z.string().optional(),
  paymentStatus: z.string().optional(),
  paymentId: z.string().optional(),
  vanLocationName: z.string().optional(),
  buzzerAlert: z
    .object({
      title: z.string(),
      message: z.string(),
      vibrate: z.array(z.number()).optional(),
    })
    .optional(),
});

const InventoryChangedPayloadSchema = z.object({
  coffeeBeansKg: z.number().nonnegative().optional(),
  wholeMilkLiters: z.number().nonnegative().optional(),
  oatMilkLiters: z.number().nonnegative().optional(),
  paperCupsCount: z.number().int().nonnegative().optional(),
  pastriesCount: z.number().int().nonnegative().optional(),
  vanillaGelatoTubs: z.number().nonnegative().optional(),
  moninSyrupBottles: z.number().nonnegative().optional(),
});

const LocationChangedPayloadSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1, "Location name is required"),
  spotName: z.string().min(1, "Spot name is required"),
  coordinates: z.object({
    lat: z.number(),
    lng: z.number(),
  }),
  address: z.string().optional(),
  city: z.string().optional(),
  isActive: z.boolean().optional(),
});

const CurbsideSignalPayloadSchema = z.object({
  orderId: z.string().min(1, "orderId is required"),
  vehicleInfo: z.string().min(1, "vehicleInfo is required"),
  arrivedAt: z.number().optional(),
  customerName: z.string().optional(),
});

const FlashDealChangedPayloadSchema = z.object({
  active: z.boolean(),
  itemId: z.string().min(1),
  discountPercent: z.number().min(0).max(100),
  originalPrice: z.number().positive(),
  dealPrice: z.number().positive(),
  tagline: z.string().optional(),
  expiresAt: z.number(),
});

export async function POST(req: NextRequest) {
  try {
    // 1. IP Rate Limiting (30 events per 60 seconds per IP, sensitive in production)
    const clientIp = getClientIp(req);
    const rateLimit = await checkRateLimit(clientIp, "realtime-event", 30, 60, {
      sensitive: true,
    });
    if (!rateLimit.success) {
      if (rateLimit.error === "RATE_LIMITER_UNAVAILABLE") {
        return NextResponse.json(
          { error: "Real-time event rate limiting service temporarily unavailable. Please retry shortly." },
          { status: 503 }
        );
      }
      return NextResponse.json(
        { error: "Too many real-time events submitted. Rate limit exceeded." },
        { status: 429 }
      );
    }

    // 2. Safe JSON Body Parse
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Malformed JSON payload" }, { status: 400 });
    }

    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid JSON object" }, { status: 400 });
    }

    const { type, payload } = body as { type?: unknown; payload?: unknown };

    if (!type || typeof type !== "string") {
      return NextResponse.json(
        { error: "Missing or invalid event 'type' parameter." },
        { status: 400 }
      );
    }

    if (type === "INITIAL_SYNC") {
      return NextResponse.json(
        { error: "INITIAL_SYNC is an internal system event and cannot be emitted by clients." },
        { status: 400 }
      );
    }

    // 3. Whitelist Verification
    if (!ALLOWED_EVENT_TYPES.includes(type as AllowedEventType)) {
      return NextResponse.json(
        {
          error: `Unsupported event type: '${type}'. Allowed types: ${ALLOWED_EVENT_TYPES.join(", ")}`,
        },
        { status: 400 }
      );
    }

    const eventType = type as AllowedEventType;

    // 4. Role-Based Authorization for Staff Events
    if (STAFF_ONLY_EVENT_TYPES.has(eventType)) {
      const token = req.cookies.get("brew_session")?.value;
      if (!token) {
        return NextResponse.json(
          {
            error: `Unauthorized: Emitting staff event '${eventType}' requires valid staff session authentication.`,
          },
          { status: 401 }
        );
      }
      const user = await verifySessionToken(token);
      if (
        !user ||
        (user.sid && (await isSessionRevoked(user.sid, user.role, user.expiresAt)))
      ) {
        return NextResponse.json(
          {
            error: `Unauthorized: Staff session expired or revoked. Please log in again.`,
          },
          { status: 401 }
        );
      }
      if (user.role !== "barista" && user.role !== "fleet_admin") {
        return NextResponse.json(
          {
            error: `Forbidden: Emitting staff event '${eventType}' requires barista or fleet_admin role.`,
          },
          { status: 403 }
        );
      }
    }

    // 5. Strict Payload Validation Per Event Type
    let validatedPayload: unknown = payload;

    switch (eventType) {
      case "ORDER_CREATED": {
        const res = OrderCreatedPayloadSchema.safeParse(payload);
        if (!res.success) {
          return NextResponse.json(
            { error: `Invalid ORDER_CREATED payload: ${res.error.issues.map((i) => i.message).join(", ")}` },
            { status: 400 }
          );
        }
        // Mask customer phone to prevent broadcasting unmasked PII over public SSE
        const data = res.data;
        if (data.customerPhone) {
          data.customerPhone = maskPhone(data.customerPhone);
        }
        validatedPayload = data;
        break;
      }
      case "ORDER_STATUS_CHANGED": {
        const res = OrderStatusChangedPayloadSchema.safeParse(payload);
        if (!res.success) {
          return NextResponse.json(
            { error: `Invalid ORDER_STATUS_CHANGED payload: ${res.error.issues.map((i) => i.message).join(", ")}` },
            { status: 400 }
          );
        }
        validatedPayload = res.data;
        break;
      }
      case "INVENTORY_CHANGED": {
        const res = InventoryChangedPayloadSchema.safeParse(payload);
        if (!res.success) {
          return NextResponse.json(
            { error: `Invalid INVENTORY_CHANGED payload: ${res.error.issues.map((i) => i.message).join(", ")}` },
            { status: 400 }
          );
        }
        validatedPayload = res.data;
        break;
      }
      case "LOCATION_CHANGED": {
        const res = LocationChangedPayloadSchema.safeParse(payload);
        if (!res.success) {
          return NextResponse.json(
            { error: `Invalid LOCATION_CHANGED payload: ${res.error.issues.map((i) => i.message).join(", ")}` },
            { status: 400 }
          );
        }
        validatedPayload = res.data;
        break;
      }
      case "CURBSIDE_SIGNAL": {
        const res = CurbsideSignalPayloadSchema.safeParse(payload);
        if (!res.success) {
          return NextResponse.json(
            { error: `Invalid CURBSIDE_SIGNAL payload: ${res.error.issues.map((i) => i.message).join(", ")}` },
            { status: 400 }
          );
        }
        validatedPayload = res.data;
        break;
      }
      case "FLASH_DEAL_CHANGED": {
        const res = FlashDealChangedPayloadSchema.safeParse(payload);
        if (!res.success) {
          return NextResponse.json(
            { error: `Invalid FLASH_DEAL_CHANGED payload: ${res.error.issues.map((i) => i.message).join(", ")}` },
            { status: 400 }
          );
        }
        validatedPayload = res.data;
        break;
      }
      case "FUTURE_STOPS_CHANGED": {
        if (!Array.isArray(payload)) {
          return NextResponse.json(
            { error: "FUTURE_STOPS_CHANGED requires an array of stops" },
            { status: 400 }
          );
        }
        validatedPayload = payload;
        break;
      }
    }

    const event: ServerRealtimeEvent = {
      type: eventType,
      payload: validatedPayload,
      timestamp: Date.now(),
    };

    // 6. Broadcast sanitized event across all connected clients
    broadcastRealtimeEvent(event);

    return NextResponse.json({ success: true, timestamp: event.timestamp });
  } catch (error: unknown) {
    console.error("Failed to broadcast realtime event:", error);
    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
