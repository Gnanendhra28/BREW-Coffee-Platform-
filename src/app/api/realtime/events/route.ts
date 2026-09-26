import { NextRequest, NextResponse } from "next/server";
import {
  broadcastRealtimeEvent,
  ServerRealtimeEvent,
} from "@/lib/serverRealtimeStore";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { type, payload } = body;

    if (!type || !payload) {
      return NextResponse.json(
        { error: "Missing event 'type' or 'payload'" },
        { status: 400 }
      );
    }

    const event: ServerRealtimeEvent = {
      type,
      payload,
      timestamp: Date.now(),
    };

    // Broadcast across all connected screens / devices
    broadcastRealtimeEvent(event);

    return NextResponse.json({ success: true, timestamp: event.timestamp });
  } catch (error: unknown) {
    console.error("Failed to broadcast realtime event:", error);
    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
