import { NextRequest, NextResponse } from "next/server";
import { broadcastRealtimeEvent } from "../../../../lib/serverRealtimeStore";
import { getSubscriptionsForOrder } from "../../../../lib/pushSubscriptionStore";
import { verifySessionToken, getStaffPins } from "../../../../lib/authTokens";
import { isSessionRevoked } from "../../../../lib/sessionRevocation";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    // Staff Authorization Check: Triggering buzzers is restricted to authorized barista crew
    const token = req.cookies.get("brew_session")?.value;
    const staffPinHeader = req.headers.get("x-staff-pin");
    const { baristaPin, fleetAdminPin } = getStaffPins();

    let isAuthorized = false;

    if (
      staffPinHeader &&
      ((baristaPin && staffPinHeader === baristaPin) ||
        (fleetAdminPin && staffPinHeader === fleetAdminPin))
    ) {
      isAuthorized = true;
    } else if (token) {
      const user = await verifySessionToken(token);
      if (
        user &&
        (user.role === "barista" || user.role === "fleet_admin") &&
        !(user.sid && (await isSessionRevoked(user.sid, user.role, user.expiresAt)))
      ) {
        isAuthorized = true;
      }
    }

    if (!isAuthorized) {
      return NextResponse.json(
        { error: "Forbidden: Verified barista or fleet_admin staff authorization required to trigger hardware buzzer." },
        { status: 403 }
      );
    }

    const body = await req.json();
    const { orderId, orderNumber, vanLocationName } = body;

    if (!orderId) {
      return NextResponse.json({ error: "Missing orderId" }, { status: 400 });
    }

    const title = `☕ Token #${orderNumber || "Your order"} is ready at ${vanLocationName || "Van Window 1"}!`;
    const message = "Your handcrafted artisanal coffee is ready for pickup. Please collect your order!";

    // 1. Broadcast real-time hardware buzzer pulse to client screens via SSE
    broadcastRealtimeEvent({
      type: "ORDER_STATUS_CHANGED",
      payload: {
        orderId,
        orderNumber,
        status: "ready",
        vanLocationName,
        buzzerAlert: {
          title,
          message,
          vibrate: [300, 100, 300, 100, 600],
        },
      },
      timestamp: Date.now(),
    });

    // 2. Query stored Web Push subscriptions
    const subscriptions = getSubscriptionsForOrder(orderId);
    console.log(
      `[HARDWARE BUZZER DISPATCH] Fired Web Push buzzer for Order #${orderNumber || orderId} to ${subscriptions.length} registered device(s)`
    );

    return NextResponse.json({
      success: true,
      orderId,
      dispatched: true,
      subscribersCount: subscriptions.length,
      vibrationPattern: [300, 100, 300, 100, 600],
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to trigger buzzer";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
