import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { readBoundedJson } from "../../../../lib/boundedBody";
import {
  getStoredPaymentOrder,
  markStoredPaymentOrderPaid,
  isPaymentIdProcessed,
  markPaymentIdProcessed,
} from "../../../../lib/serverPaymentStore";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    // 0. Stream-bounded body read: enforces strict 100KB limit
    const readResult = await readBoundedJson<Record<string, unknown>>(req);
    if (!readResult.ok || readResult.response) {
      return readResult.response!;
    }
    const body = readResult.data || {};
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = body as {
      razorpay_order_id?: string;
      razorpay_payment_id?: string;
      razorpay_signature?: string;
    };

    // 1. Validate required identifiers
    if (!razorpay_order_id || typeof razorpay_order_id !== "string") {
      return NextResponse.json(
        { error: "Missing or invalid razorpay_order_id" },
        { status: 400 }
      );
    }
    if (!razorpay_payment_id || typeof razorpay_payment_id !== "string") {
      return NextResponse.json(
        { error: "Missing or invalid razorpay_payment_id" },
        { status: 400 }
      );
    }

    // 2. Prevent Replay Attacks: Check if payment ID has already been processed
    if (await isPaymentIdProcessed(razorpay_payment_id)) {
      return NextResponse.json(
        {
          success: true,
          verified: true,
          alreadyProcessed: true,
          orderId: razorpay_order_id,
          paymentId: razorpay_payment_id,
          message: "Payment already verified and processed.",
        },
        { status: 200 }
      );
    }

    // 3. Cryptographically Verify Razorpay HMAC Signature
    const keySecret = process.env.RAZORPAY_KEY_SECRET || "brew_razorpay_secret_test_2026";

    if (!razorpay_signature || typeof razorpay_signature !== "string") {
      return NextResponse.json(
        { error: "Missing razorpay_signature for verification." },
        { status: 400 }
      );
    }

    const generatedSignature = crypto
      .createHmac("sha256", keySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    // Constant-time buffer comparison to prevent timing attacks
    const sigBuf = Buffer.from(razorpay_signature);
    const genBuf = Buffer.from(generatedSignature);

    if (sigBuf.length !== genBuf.length || !crypto.timingSafeEqual(sigBuf, genBuf)) {
      return NextResponse.json(
        { success: false, error: "Cryptographic signature verification failed" },
        { status: 400 }
      );
    }

    // 4. Cross-Reference Stored Server Order in Cloud Firestore
    const storedOrder = await getStoredPaymentOrder(razorpay_order_id);
    if (storedOrder) {
      if (storedOrder.paymentStatus === "failed") {
        return NextResponse.json(
          { error: "Cannot verify payment for an order marked as failed." },
          { status: 400 }
        );
      }
      await markStoredPaymentOrderPaid(razorpay_order_id, razorpay_payment_id, {
        verifiedAt: Date.now(),
        verificationChannel: "client_api",
      });
    }

    // Mark payment ID as processed to block duplicate verification
    await markPaymentIdProcessed(razorpay_payment_id);

    return NextResponse.json({
      success: true,
      verified: true,
      paymentId: razorpay_payment_id,
      orderId: razorpay_order_id,
      amount: storedOrder?.amountInPaise,
      currency: storedOrder?.currency || "INR",
      timestamp: Date.now(),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Payment verification error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
