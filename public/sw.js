// BREW Mobile Coffee Sanctuary - Hardware Buzzer & Web Push Service Worker
// Enables lock-screen vibration pager notifications when coffee is ready.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// 1. Web Push Notification Listener (Fires when screen is locked or in background)
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "☕ Your Coffee is Ready!", body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "☕ Your BREW Order is Ready!";
  const options = {
    body: data.body || "Your coffee is ready at Van Window 1. Please collect your drink!",
    icon: "/assets/cup1.png",
    badge: "/assets/cup1.png",
    // Hardware pager vibration pattern: [buzz, pause, buzz, pause, long buzz]
    vibrate: data.vibrate || [300, 100, 300, 100, 600],
    tag: `brew-order-${data.orderId || "ready"}`,
    renotify: true,
    requireInteraction: true,
    data: {
      url: data.url || (data.orderId ? `/order-status/${data.orderId}` : "/"),
      orderId: data.orderId,
    },
    actions: [
      { action: "open_buzzer", title: "Open Digital Buzzer" },
      { action: "dismiss", title: "Dismiss" },
    ],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// 2. Notification Click Handler (Brings user directly to their digital buzzer)
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  if (event.action === "dismiss") return;

  const targetUrl = event.notification.data?.url || "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      // Focus existing window if open
      for (const client of clientList) {
        if (client.url.includes(targetUrl) && "focus" in client) {
          return client.focus();
        }
      }
      // Otherwise open new window
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});

// 3. In-App Message Listener (Direct trigger from client)
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "TRIGGER_BUZZER_NOTIFICATION") {
    const { title, body, orderId } = event.data;
    self.registration.showNotification(title || "☕ Order Ready!", {
      body: body || "Your drink is handcrafted and ready at the window!",
      icon: "/assets/cup1.png",
      vibrate: [300, 100, 300, 100, 600],
      tag: `brew-order-${orderId}`,
      renotify: true,
      data: { url: `/order-status/${orderId}` },
    });
  }
});
