import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { amount, currency = "INR", receipt, customerName, customerPhone, vanLocationName } = body;

    if (!amount || amount <= 0) {
      return NextResponse.json(
        { error: "Invalid payment amount" },
        { status: 400 }
      );
    }

    const amountInPaise = Math.round(amount * 100);
    const keyId = process.env.RAZORPAY_KEY_ID || process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;

    // 1. If live Razorpay API keys are configured, request order from Razorpay
    if (keyId && keySecret) {
      const authHeader = "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64");
      const rzpRes = await fetch("https://api.razorpay.com/v1/orders", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader,
        },
        body: JSON.stringify({
          amount: amountInPaise,
          currency,
          receipt: receipt || `rcpt_${Date.now()}`,
          payment_capture: 1,
          notes: {
            customerName: customerName || "Sanctuary Guest",
            customerPhone: customerPhone || "N/A",
            vanLocation: vanLocationName || "BREW Mobile Station",
          },
        }),
      });

      if (!rzpRes.ok) {
        const errorData = await rzpRes.json();
        console.error("Razorpay order creation failed:", errorData);
        return NextResponse.json(
          { error: errorData.error?.description || "Failed to create Razorpay order" },
          { status: rzpRes.status }
        );
      }

      const rzpOrder = await rzpRes.json();
      return NextResponse.json({
        success: true,
        orderId: rzpOrder.id,
        amount: rzpOrder.amount,
        currency: rzpOrder.currency,
        keyId,
        isLive: true,
      });
    }

    // 2. Resilient Test / Simulation Mode (when API keys are not yet plugged into .env)
    const testOrderId = `order_test_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    return NextResponse.json({
      success: true,
      orderId: testOrderId,
      amount: amountInPaise,
      currency: "INR",
      keyId: "rzp_test_brew_mobile_2026",
      isLive: false,
      message: "Razorpay Test Gateway initialized. Ready for UPI / Cards simulation.",
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal payment error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
