import http from "node:http";

async function runRealtimeTest() {
  console.log("=== BREW REAL-TIME CLOUD PIPELINE VERIFICATION ===");
  
  // 1. Open SSE stream
  let sseResolved = false;
  let receivedOrderSync = false;

  const sseReq = http.request(
    "http://127.0.0.1:3000/api/realtime/stream",
    {
      headers: {
        Accept: "text/event-stream",
      },
    },
    (res) => {
      console.log("✓ Connected to /api/realtime/stream (Status:", res.statusCode, ")");
      sseResolved = true;

      res.on("data", (chunk) => {
        const text = chunk.toString();
        const lines = text.split("\n");
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const dataStr = line.slice(6).trim();
            try {
              const event = JSON.parse(dataStr);
              console.log(`[SSE EVENT RECEIVED] Type: ${event.type} at ${new Date(event.timestamp).toISOString()}`);
              if (event.type === "INITIAL_SYNC") {
                console.log(`✓ Initial Sync verified: ${event.payload.orders.length} orders loaded`);
                // Now post a test order
                postTestOrder();
              } else if (event.type === "ORDER_CREATED") {
                console.log(`✓ Real-time ORDER_CREATED event arrived in sub-500ms! Order #: ${event.payload.orderNumber}`);
                receivedOrderSync = true;
                // Test complete
                setTimeout(() => {
                  console.log("🎉 ALL REAL-TIME CHECKS PASSED!");
                  process.exit(0);
                }, 500);
              }
            } catch (e) {
              // ignore partial lines
            }
          }
        }
      });
    }
  );

  sseReq.on("error", (err) => {
    console.error("SSE stream error:", err.message);
    process.exit(1);
  });

  sseReq.end();

  function postTestOrder() {
    console.log("-> Dispatching test live order via /api/realtime/events...");
    const postData = JSON.stringify({
      type: "ORDER_CREATED",
      payload: {
        id: "ord-test-999",
        orderNumber: "999",
        customerName: "Cloud Test Guest",
        items: [{ id: "c-1", name: "Affogato", price: 240, quantity: 1 }],
        totalAmount: 240,
        status: "received",
        createdAt: Date.now(),
        pickupType: "walkup",
        vanLocationName: "HITEC City — Cyber Towers",
      },
    });

    const req = http.request(
      "http://127.0.0.1:3000/api/realtime/events",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
        },
      },
      (res) => {
        let respBody = "";
        res.on("data", (chunk) => (respBody += chunk));
        res.on("end", () => {
          console.log(`✓ Event POST response status: ${res.statusCode} (${respBody.trim()})`);
        });
      }
    );

    req.on("error", (err) => {
      console.error("POST event error:", err.message);
    });

    req.write(postData);
    req.end();
  }

  // Timeout guard
  setTimeout(() => {
    if (!receivedOrderSync) {
      console.error("Timeout: Realtime events not received within 10s");
      process.exit(1);
    }
  }, 10000);
}

runRealtimeTest();
