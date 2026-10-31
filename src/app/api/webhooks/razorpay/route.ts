import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { broadcastRealtimeEvent } from "@/lib/serverRealtimeStore";
import { dispatchDigitalReceipt } from "@/lib/receiptNotifier";
import { maskPhone } from "@/lib/observability/logger";
import {
  processWebhookTransaction,
  isPaymentIdProcessed,
} from "@/lib/serverPaymentStore";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text();
    const signature = req.headers.get("x-razorpay-signature");
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || "brew_webhook_secret_dev_2026";

    // 1. Mandatory Cryptographic HMAC-SHA256 Signature Verification
    if (!signature) {
      return NextResponse.json(
        { error: "Missing x-razorpay-signature webhook header" },
        { status: 400 }
      );
    }

    const expectedSignature = crypto
      .createHmac("sha256", webhookSecret)
      .update(rawBody)
      .digest("hex");

    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expectedSignature);

    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      console.error("[RAZORPAY WEBHOOK] Cryptographic signature mismatch!");
      return NextResponse.json({ error: "Invalid webhook signature" }, { status: 400 });
    }

    // 2. Safe Payload Parse
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: "Malformed webhook JSON payload" }, { status: 400 });
    }

    const event = typeof payload.event === "string" ? payload.event : "";
    const eventId =
      (typeof payload.id === "string" && payload.id) ||
      (typeof payload.event_id === "string" && payload.event_id) ||
      `evt_${crypto.createHash("sha256").update(rawBody).digest("hex").slice(0, 24)}`;

    // 3. Handle Payment Capture & Order Paid Events via Atomic Cloud Firestore Transaction
    if (event === "payment.captured" || event === "order.paid") {
      const payloadObj = (payload.payload as Record<string, unknown>) || {};
      const paymentObj = (payloadObj.payment as Record<string, unknown>) || {};
      const paymentEntity = (paymentObj.entity as Record<string, unknown>) || {};
      const notes = (paymentEntity.notes as Record<string, unknown>) || {};

      const orderObj = (payloadObj.order as Record<string, unknown>) || {};
      const orderEntity = (orderObj.entity as Record<string, unknown>) || {};

      const orderId =
        (typeof notes.internalOrderId === "string" && notes.internalOrderId) ||
        (typeof notes.orderId === "string" && notes.orderId) ||
        (typeof paymentEntity.order_id === "string" && paymentEntity.order_id) ||
        (typeof orderEntity.id === "string" && orderEntity.id) ||
        (typeof orderEntity.receipt === "string" && orderEntity.receipt) ||
        "";
      const paymentId = typeof paymentEntity.id === "string" ? paymentEntity.id : "";
      const customerPhone = typeof notes.customerPhone === "string" ? notes.customerPhone : undefined;
      const customerName = typeof notes.customerName === "string" ? notes.customerName : "Sanctuary Guest";
      const receivedAmountInPaise = typeof paymentEntity.amount === "number" ? paymentEntity.amount : 0;
      const currency = typeof paymentEntity.currency === "string" ? paymentEntity.currency : "INR";

      // Replay check for paymentId
      if (paymentId && (await isPaymentIdProcessed(paymentId))) {
        return NextResponse.json({ status: "ok", alreadyProcessed: true, duplicatePayment: true }, { status: 200 });
      }

      // Execute Atomic Webhook Transaction
      const txResult = await processWebhookTransaction(eventId, {
        event,
        orderId,
        paymentId,
        receivedAmountInPaise,
        currency,
      });

      if (!txResult.success) {
        console.error(`[RAZORPAY WEBHOOK] Transaction failed: ${txResult.error}`);
        return NextResponse.json({ error: txResult.error || "Webhook transaction failed" }, { status: 400 });
      }

      if (txResult.alreadyProcessed) {
        return NextResponse.json(
          { status: "ok", received: true, alreadyProcessed: true },
          { status: 200 }
        );
      }

      // Broadcast verified status to Barista Van KDS via real-time SSE hub
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

        // Trigger digital receipt with masked PII logging
        const maskedPhone = customerPhone ? maskPhone(customerPhone) : "N/A";
        console.log(
          `[RAZORPAY WEBHOOK] Payment verified for Order #${orderId} (Payment ID: ${paymentId}, Phone: ${maskedPhone})`
        );

        await dispatchDigitalReceipt({
          orderId,
          orderNumber: orderId.replace(/^ord-/, "").split("-")[0] || "101",
          customerName,
          customerPhone,
          items: [],
          totalAmount: Math.round(receivedAmountInPaise / 100),
          vanLocationName: typeof notes.vanLocation === "string" ? notes.vanLocation : "BREW Mobile Station",
          paymentId,
          createdAt: Date.now(),
        });
      }
    } else if (event === "payment.failed") {
      const payloadObj = (payload.payload as Record<string, unknown>) || {};
      const paymentObj = (payloadObj.payment as Record<string, unknown>) || {};
      const paymentEntity = (paymentObj.entity as Record<string, unknown>) || {};
      const notes = (paymentEntity.notes as Record<string, unknown>) || {};

      const orderId =
        (typeof notes.internalOrderId === "string" && notes.internalOrderId) ||
        (typeof notes.orderId === "string" && notes.orderId) ||
        (typeof paymentEntity.order_id === "string" && paymentEntity.order_id) ||
        "";
      const paymentId = typeof paymentEntity.id === "string" ? paymentEntity.id : "";
      const errorDesc = typeof paymentEntity.error_description === "string" ? paymentEntity.error_description : "Payment failed";

      console.warn(`[RAZORPAY WEBHOOK] Payment failed for Order #${orderId}: ${errorDesc}`);

      if (orderId) {
        broadcastRealtimeEvent({
          type: "ORDER_STATUS_CHANGED",
          payload: {
            orderId,
            status: "pending",
            paymentStatus: "failed",
            errorDescription: errorDesc,
          },
          timestamp: Date.now(),
        });
      }

      const txResult = await processWebhookTransaction(eventId, {
        event,
        orderId,
        paymentId,
        receivedAmountInPaise: typeof paymentEntity.amount === "number" ? paymentEntity.amount : 0,
        currency: "INR",
      });
      if (txResult.alreadyProcessed) {
        return NextResponse.json({ status: "ok", received: true, alreadyProcessed: true }, { status: 200 });
      }
    } else {
      // Record any non-payment events in transaction as processed
      const txResult = await processWebhookTransaction(eventId, {
        event,
        orderId: "",
        paymentId: "",
        receivedAmountInPaise: 0,
        currency: "INR",
      });
      if (txResult.alreadyProcessed) {
        return NextResponse.json({ status: "ok", received: true, alreadyProcessed: true }, { status: 200 });
      }
    }

    return NextResponse.json({ status: "ok", received: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Webhook processing error";
    console.error("Error handling Razorpay webhook:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
