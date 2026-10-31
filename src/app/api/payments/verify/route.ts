import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import {
  getStoredPaymentOrder,
  markStoredPaymentOrderPaid,
  isPaymentIdProcessed,
  markPaymentIdProcessed,
} from "../../../../lib/serverPaymentStore";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    // 0. Payload Size Guard
    const contentLength = req.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > 100 * 1024) {
      return NextResponse.json(
        { error: "Payload too large. Maximum request size is 100KB." },
        { status: 413 }
      );
    }

    let body: Record<string, unknown> = {};
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "Malformed JSON payload" }, { status: 400 });
    }
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
