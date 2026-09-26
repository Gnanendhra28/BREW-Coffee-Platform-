import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { broadcastRealtimeEvent } from "@/lib/serverRealtimeStore";
import { dispatchDigitalReceipt } from "@/lib/receiptNotifier";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text();
    const signature = req.headers.get("x-razorpay-signature");
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || "brew_webhook_secret_dev_2026";

    // 1. Cryptographically verify Razorpay HMAC signature
    if (signature) {
      const expectedSignature = crypto
        .createHmac("sha256", webhookSecret)
        .update(rawBody)
        .digest("hex");

      if (signature !== expectedSignature && process.env.NODE_ENV === "production") {
        console.error("Razorpay webhook signature mismatch!");
        return NextResponse.json({ error: "Invalid webhook signature" }, { status: 400 });
      }
    }

    const payload = JSON.parse(rawBody);
    const event = payload.event;
    console.log(`[RAZORPAY WEBHOOK RECEIVED] Event: ${event}`);

    // 2. Handle successful payment captured or order paid
    if (event === "payment.captured" || event === "order.paid") {
      const paymentEntity = payload.payload?.payment?.entity || {};
      const notes = paymentEntity.notes || {};
      const orderId = notes.orderId || payload.payload?.order?.entity?.receipt;
      const paymentId = paymentEntity.id;
      const customerPhone = notes.customerPhone;
      const customerName = notes.customerName;

      // Broadcast instant paid badge to Barista Van KDS via real-time SSE hub
      if (orderId) {
        broadcastRealtimeEvent({
          type: "ORDER_STATUS_CHANGED",
          payload: {
            orderId,
            status: "brewing",
            paymentStatus: "paid",
            paymentId,
          },
          timestamp: Date.now(),
        });

        // Trigger instant digital WhatsApp receipt
        await dispatchDigitalReceipt({
          orderId,
          orderNumber: orderId.replace(/^ord-/, "").split("-")[0] || "101",
          customerName: customerName || "Sanctuary Guest",
          customerPhone: customerPhone,
          items: [],
          totalAmount: Math.round((paymentEntity.amount || 0) / 100),
          vanLocationName: notes.vanLocation || "BREW Mobile Station",
          paymentId,
          createdAt: Date.now(),
        });
      }
    }

    return NextResponse.json({ status: "ok", received: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Webhook processing error";
    console.error("Error handling Razorpay webhook:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
