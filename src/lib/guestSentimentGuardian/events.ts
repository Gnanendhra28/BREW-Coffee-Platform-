export type GuardianEventType =
  | "FEEDBACK_RECEIVED"
  | "LOW_RATING_DETECTED"
  | "CRITICAL_ISSUE_DETECTED"
  | "RECOVERY_APPROVED"
  | "VOUCHER_ISSUED"
  | "RECOVERY_RESOLVED";

export interface GuardianEvent {
  eventId: string;
  eventType: GuardianEventType;
  storeId: string;
  timestamp: number;
  payload: unknown;
}

type GuardianEventHandler = (event: GuardianEvent) => Promise<void> | void;

const GUARDIAN_EVENT_LISTENERS = new Map<GuardianEventType, Set<GuardianEventHandler>>();

export function onGuardianEvent(
  eventType: GuardianEventType,
  handler: GuardianEventHandler
): () => void {
  let set = GUARDIAN_EVENT_LISTENERS.get(eventType);
  if (!set) {
    set = new Set();
    GUARDIAN_EVENT_LISTENERS.set(eventType, set);
  }
  set.add(handler);

  return () => {
    set?.delete(handler);
  };
}

export function clearGuardianEventListeners(): void {
  GUARDIAN_EVENT_LISTENERS.clear();
}

/**
 * Emits an event to all registered listeners.
 */
export async function emitGuardianEvent(event: GuardianEvent): Promise<void> {
  const set = GUARDIAN_EVENT_LISTENERS.get(event.eventType);
  if (!set || set.size === 0) return;

  const promises: Promise<void>[] = [];
  for (const handler of set) {
    try {
      const res = handler(event);
      if (res instanceof Promise) {
        promises.push(res);
      }
    } catch (err) {
      console.error(`Error in event handler for ${event.eventType}:`, err);
    }
  }

  await Promise.allSettled(promises);
}
