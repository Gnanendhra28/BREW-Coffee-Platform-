// Global Push Subscription Store for Web Push & Pager Notifications

const globalSubscriptionsKey = Symbol.for("brew.push.subscriptions");

export interface StoredSubscription {
  orderNumber?: string;
  subscription: unknown;
  registeredAt: number;
}

interface GlobalWithSubscriptions {
  [globalSubscriptionsKey]?: Map<string, StoredSubscription[]>;
}

const g = globalThis as unknown as GlobalWithSubscriptions;
if (!g[globalSubscriptionsKey]) {
  g[globalSubscriptionsKey] = new Map<string, StoredSubscription[]>();
}

const subscriptionsMap = g[globalSubscriptionsKey]!;

export function addSubscription(
  orderId: string,
  entry: { orderNumber?: string; subscription: unknown }
): number {
  const current = subscriptionsMap.get(orderId) || [];
  current.push({
    orderNumber: entry.orderNumber,
    subscription: entry.subscription,
    registeredAt: Date.now(),
  });
  subscriptionsMap.set(orderId, current);
  return current.length;
}

export function getSubscriptionsForOrder(orderId: string): StoredSubscription[] {
  return subscriptionsMap.get(orderId) || [];
}
