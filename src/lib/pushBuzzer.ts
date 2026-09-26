// Hardware Pager Buzzer & Web Push Notification Client Library
// Vibrates device with custom haptic sequences and synthesizes acoustic chimes.

export interface PushSubscriptionData {
  orderId: string;
  orderNumber?: string;
  subscription?: unknown;
  endpoint?: string;
  token?: string;
}

/**
 * Registers the Service Worker for background Web Push and lock-screen alerts.
 */
export async function registerBuzzerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
    return null;
  }

  try {
    const registration = await navigator.serviceWorker.register("/sw.js", {
      scope: "/",
    });
    return registration;
  } catch (err) {
    console.warn("ServiceWorker registration failed:", err);
    return null;
  }
}

/**
 * Requests Notification permission and registers push subscription.
 */
export async function requestBuzzerPermission(
  orderId: string,
  orderNumber?: string
): Promise<{ granted: boolean; permission: NotificationPermission }> {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return { granted: false, permission: "denied" };
  }

  try {
    const permission = await Notification.requestPermission();
    const granted = permission === "granted";

    if (granted) {
      const swReg = await registerBuzzerServiceWorker();
      let subscription: PushSubscription | null = null;

      if (swReg && "pushManager" in swReg) {
        try {
          subscription = await swReg.pushManager.getSubscription();
          if (!subscription) {
            // Subscribe with userVisibleOnly
            const vapidKey =
              process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ||
              "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDZKrxZJjSOUaoZ6jYiTWCnWgL-5G5V_EwL1_z5wA_gM";
            subscription = await swReg.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: vapidKey,
            });
          }
        } catch {
          // Push manager fallback
        }
      }

      // Register subscription on server
      await fetch("/api/notifications/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId,
          orderNumber,
          subscription: subscription ? subscription.toJSON() : null,
          device: navigator.userAgent,
          timestamp: Date.now(),
        }),
      });
    }

    return { granted, permission };
  } catch (err) {
    console.warn("Error requesting notification permission:", err);
    return { granted: false, permission: "denied" };
  }
}

/**
 * Synthesizes acoustic cafe chime via Web Audio API.
 */
export function playBuzzerAcousticChime(): void {
  if (typeof window === "undefined") return;

  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5, E5, G5, C6 (Major triad fanfare)

    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.12);

      gain.gain.setValueAtTime(0, ctx.currentTime + idx * 0.12);
      gain.gain.linearRampToValueAtTime(0.28, ctx.currentTime + idx * 0.12 + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + idx * 0.12 + 0.7);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(ctx.currentTime + idx * 0.12);
      osc.stop(ctx.currentTime + idx * 0.12 + 0.75);
    });
  } catch (e) {
    console.warn("Audio chime synthesis failed:", e);
  }
}

/**
 * Triggers full hardware haptic pager vibration sequence and alerts.
 * Pattern: [300ms buzz, 100ms pause, 300ms buzz, 100ms pause, 600ms buzz]
 */
export function triggerHardwareBuzzer(details?: {
  orderNumber?: string;
  orderId?: string;
  vanLocationName?: string;
}): void {
  if (typeof window === "undefined") return;

  // 1. Hardware Haptic Pager Vibration Sequence
  if ("vibrate" in navigator) {
    try {
      navigator.vibrate([300, 100, 300, 100, 600]);
    } catch {
      // Vibrate fallback
    }
  }

  // 2. Synthesize audio chime
  playBuzzerAcousticChime();

  // 3. In-App or OS notification if permitted
  if ("Notification" in window && Notification.permission === "granted") {
    try {
      const orderNum = details?.orderNumber || "Your";
      const station = details?.vanLocationName || "Van Window 1";
      const title = `☕ Token #${orderNum} is ready at ${station}!`;
      const body = "Your handcrafted coffee is ready. Please collect your order!";

      // Check if service worker is active
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({
          type: "TRIGGER_BUZZER_NOTIFICATION",
          title,
          body,
          orderId: details?.orderId,
        });
      } else {
        const options: NotificationOptions & { vibrate?: number[] } = {
          body,
          icon: "/assets/cup1.png",
          badge: "/assets/cup1.png",
          vibrate: [300, 100, 300, 100, 600],
          tag: `brew-order-ready-${details?.orderId || "direct"}`,
        };
        new Notification(title, options as NotificationOptions);
      }
    } catch {
      // Notification fallback
    }
  }
}
