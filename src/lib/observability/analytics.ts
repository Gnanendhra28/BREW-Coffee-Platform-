// Product Analytics & Funnel Tracking Engine (PostHog & GA4 Standard)
// Measures conversion funnels: Menu View -> Cart Add -> Curbside Check-in -> Order Completed.

export type AnalyticsEventName =
  | "menu_view"
  | "cart_item_added"
  | "cart_item_removed"
  | "curbside_arrival_pulsed"
  | "payment_initiated"
  | "order_completed"
  | "flash_deal_claimed"
  | "digital_buzzer_enabled";

export interface AnalyticsEvent {
  event: AnalyticsEventName;
  properties?: Record<string, unknown>;
  timestamp: string;
}

class AnalyticsTracker {
  private posthogKey: string | null = null;
  private gaId: string | null = null;

  constructor() {
    this.posthogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY || null;
    this.gaId = process.env.NEXT_PUBLIC_GA_ID || null;
  }

  /**
   * Tracks an arbitrary analytics event across PostHog, GA4, and console telemetry.
   */
  track(event: AnalyticsEventName, properties: Record<string, unknown> = {}): void {
    const payload: AnalyticsEvent = {
      event,
      properties: {
        ...properties,
        url: typeof window !== "undefined" ? window.location.pathname : undefined,
        device: typeof window !== "undefined" ? navigator.userAgent : undefined,
      },
      timestamp: new Date().toISOString(),
    };

    if (process.env.NODE_ENV !== "production") {
      console.log(`\x1b[35m[ANALYTICS FUNNEL]\x1b[0m ${event}:`, properties);
    }

    // 1. PostHog Client Integration
    if (typeof window !== "undefined") {
      const win = window as unknown as {
        posthog?: { capture: (ev: string, prop: unknown) => void };
        gtag?: (type: string, ev: string, prop: unknown) => void;
      };

      if (win.posthog) {
        try {
          win.posthog.capture(event, payload.properties);
        } catch {}
      }

      // 2. Google Analytics 4 (gtag) Integration
      if (win.gtag) {
        try {
          win.gtag("event", event, payload.properties);
        } catch {}
      }
    }
  }

  // --- TYPED FUNNEL EVENTS ---

  trackMenuView(category: string, totalCount: number): void {
    this.track("menu_view", { category, totalCount });
  }

  trackCartItemAdded(item: {
    id: string;
    name: string;
    price: number;
    category: string;
  }): void {
    this.track("cart_item_added", {
      itemId: item.id,
      name: item.name,
      price: item.price,
      category: item.category,
    });
  }

  trackCurbsideArrival(orderId: string, status: "approaching" | "arrived"): void {
    this.track("curbside_arrival_pulsed", { orderId, status });
  }

  trackPaymentInitiated(orderId: string, amount: number, method: string): void {
    this.track("payment_initiated", { orderId, amount, method });
  }

  trackOrderCompleted(order: {
    id: string;
    totalAmount: number;
    pickupType: string;
    itemCount: number;
  }): void {
    this.track("order_completed", {
      orderId: order.id,
      revenue: order.totalAmount,
      pickupType: order.pickupType,
      itemCount: order.itemCount,
    });
  }

  trackFlashDealClaimed(deal: {
    id: string;
    title: string;
    dealPrice: number;
  }): void {
    this.track("flash_deal_claimed", {
      dealId: deal.id,
      title: deal.title,
      price: deal.dealPrice,
    });
  }

  trackBuzzerEnabled(orderId: string): void {
    this.track("digital_buzzer_enabled", { orderId });
  }
}

export const analytics = new AnalyticsTracker();
