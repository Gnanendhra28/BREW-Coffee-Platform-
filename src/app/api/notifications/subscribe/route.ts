import { NextRequest, NextResponse } from "next/server";
import { addSubscription } from "@/lib/pushSubscriptionStore";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { orderId, orderNumber, subscription } = body;

    if (!orderId) {
      return NextResponse.json({ error: "Missing orderId" }, { status: 400 });
    }

    const count = addSubscription(orderId, { orderNumber, subscription });

    console.log(
      `[PUSH NOTIFICATIONS] Registered pager subscriber for Order #${orderNumber || orderId} (Total: ${count})`
    );

    return NextResponse.json({ success: true, count });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to register subscription";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
