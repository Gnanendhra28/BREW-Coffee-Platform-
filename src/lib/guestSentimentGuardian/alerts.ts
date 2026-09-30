// Operational Alerting & Deduplication Engine for Agent 6: ❤️ Guest Sentiment Guardian
// Alerts store managers to critical food safety issues and complaint spikes.
// Enforces deterministic alert keys to prevent notification spam.

export interface GuardianAlert {
  alertId: string;
  storeId: string;
  alertType: "CRITICAL_SAFETY_INCIDENT" | "WAIT_TIME_SPIKE" | "DRINK_QUALITY_SPIKE" | "RECOVERY_ABUSE_SPIKE";
  severity: "HIGH" | "CRITICAL";
  headline: string;
  description: string;
  dedupKey: string;
  createdAt: number;
}

const ALERTS_STORE = new Map<string, GuardianAlert>();
const ALERT_DEDUP_KEYS = new Set<string>();

export function resetAlertsStore(): void {
  ALERTS_STORE.clear();
  ALERT_DEDUP_KEYS.clear();
}

/**
 * Triggers an operational alert with strict hourly deduplication.
 */
export function triggerGuardianAlert(params: {
  storeId: string;
  alertType: "CRITICAL_SAFETY_INCIDENT" | "WAIT_TIME_SPIKE" | "DRINK_QUALITY_SPIKE" | "RECOVERY_ABUSE_SPIKE";
  severity: "HIGH" | "CRITICAL";
  headline: string;
  description: string;
  timestamp?: number;
}): { alert: GuardianAlert | null; isDuplicate: boolean } {
  const now = params.timestamp ?? Date.now();
  const dateObj = new Date(now);
  const hourBucket = `${dateObj.getFullYear()}-${dateObj.getMonth() + 1}-${dateObj.getDate()}-H${dateObj.getHours()}`;
  const dedupKey = `${params.storeId}:${params.alertType}:${hourBucket}`;

  if (ALERT_DEDUP_KEYS.has(dedupKey)) {
    return { alert: null, isDuplicate: true };
  }

  const alertId = `alert-${now}-${Math.random().toString(36).substring(2, 6)}`;
  const alert: GuardianAlert = {
    alertId,
    storeId: params.storeId,
    alertType: params.alertType,
    severity: params.severity,
    headline: params.headline,
    description: params.description,
    dedupKey,
    createdAt: now,
  };

  ALERTS_STORE.set(alertId, alert);
  ALERT_DEDUP_KEYS.add(dedupKey);

  return { alert, isDuplicate: false };
}

export function listGuardianAlerts(storeId?: string): GuardianAlert[] {
  const all = Array.from(ALERTS_STORE.values());
  if (storeId) {
    return all.filter((a) => a.storeId === storeId);
  }
  return all;
}
