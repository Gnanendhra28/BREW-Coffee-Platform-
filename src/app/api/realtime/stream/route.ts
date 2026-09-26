
import {
  subscribeToRealtimeServer,
  getRealtimeServerSnapshot,
  ServerRealtimeEvent,
} from "@/lib/serverRealtimeStore";

export const dynamic = "force-dynamic";

export async function GET() {
  const encoder = new TextEncoder();

  let unsubscribe: (() => void) | null = null;
  let keepAliveTimer: NodeJS.Timeout | null = null;

  const stream = new ReadableStream({
    start(controller) {
      // 1. Send initial snapshot immediately upon connection
      const initialSnapshot = getRealtimeServerSnapshot();
      const initialEvent: ServerRealtimeEvent = {
        type: "INITIAL_SYNC",
        payload: initialSnapshot,
        timestamp: Date.now(),
      };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(initialEvent)}\n\n`));

      // 2. Subscribe to real-time events dispatched anywhere across devices
      unsubscribe = subscribeToRealtimeServer((event) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // Stream might be closed
        }
      });

      // 3. Keep-alive ping every 20 seconds to prevent proxy disconnects
      keepAliveTimer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          // Stream might be closed
        }
      }, 20000);
    },
    cancel() {
      if (unsubscribe) unsubscribe();
      if (keepAliveTimer) clearInterval(keepAliveTimer);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
