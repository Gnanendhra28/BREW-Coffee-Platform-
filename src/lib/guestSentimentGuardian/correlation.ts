// Operational Root-Cause Correlation Engine for Agent 6: ❤️ Guest Sentiment Guardian
// Correlates complaints (e.g. wait time, missing item) with operational timelines and telemetry.
// Never assigns personal employee blame; adheres strictly to confirmed telemetry.

import {
  IssueCategory,
  OrderContext,
  RootCauseCorrelation,
  CustomerFeedback,
} from "./types";

/**
 * Correlates detected issue categories against actual order timeline and store telemetry.
 */
export function correlateOperationalRootCauses(
  feedback: CustomerFeedback,
  issues: IssueCategory[],
  order: OrderContext | null
): RootCauseCorrelation[] {
  const correlations: RootCauseCorrelation[] = [];

  for (const issue of issues) {
    if (!order) {
      correlations.push({
        issue,
        suspectedCause: "No correlated order record available for timeline verification.",
        confidence: "UNKNOWN",
      });
      continue;
    }

    switch (issue) {
      case "WAIT_TIME":
      case "ORDER_DELAY": {
        const actualWait = order.actualWaitMinutes ?? 0;
        const targetWait = order.targetWaitMinutes ?? 8;

        if (actualWait > targetWait * 1.8) {
          correlations.push({
            issue,
            suspectedCause: `Actual prep and fulfillment time was ${actualWait} mins (target SLA was ${targetWait} mins).`,
            confidence: "CONFIRMED",
            operationalTelemetry: { actualWait, targetWait, delayMinutes: actualWait - targetWait },
          });
        } else if (actualWait > targetWait) {
          correlations.push({
            issue,
            suspectedCause: `Order exceeded normal fulfillment SLA by ${actualWait - targetWait} mins.`,
            confidence: "LIKELY",
            operationalTelemetry: { actualWait, targetWait },
          });
        } else {
          correlations.push({
            issue,
            suspectedCause: `Order was recorded ready in ${actualWait} mins (within ${targetWait} mins SLA). Possible perceived wait or handoff queue.`,
            confidence: "POSSIBLE",
            operationalTelemetry: { actualWait, targetWait },
          });
        }
        break;
      }

      case "MISSING_ITEM": {
        const orderedItemNames = order.items.map((i) => i.name.toLowerCase());
        const comment = feedback.comment.toLowerCase();
        const matchedItem = orderedItemNames.find((name) =>
          comment.includes(name) || name.split(" ").some((part) => comment.includes(part))
        );

        if (matchedItem) {
          correlations.push({
            issue,
            suspectedCause: `Item '${matchedItem}' was billed in order #${order.orderNumber || order.orderId} and reported missing.`,
            confidence: "LIKELY",
            operationalTelemetry: { matchedItem, orderItems: order.items },
          });
        } else {
          correlations.push({
            issue,
            suspectedCause: "Reported missing item could not be automatically matched to billed line items.",
            confidence: "POSSIBLE",
            operationalTelemetry: { orderItems: order.items },
          });
        }
        break;
      }

      case "CURBSIDE": {
        if (order.pickupType === "curbside") {
          correlations.push({
            issue,
            suspectedCause: "Curbside vehicle arrival or bay handoff delay during rush.",
            confidence: "LIKELY",
            operationalTelemetry: { pickupType: order.pickupType },
          });
        } else {
          correlations.push({
            issue,
            suspectedCause: `Order was placed as ${order.pickupType}, but feedback references curbside.`,
            confidence: "POSSIBLE",
          });
        }
        break;
      }

      case "TEMPERATURE":
      case "DRINK_QUALITY": {
        correlations.push({
          issue,
          suspectedCause: "Beverage temperature or extraction consistency deviation during high-volume rush.",
          confidence: "POSSIBLE",
          operationalTelemetry: { orderItems: order.items },
        });
        break;
      }

      default: {
        correlations.push({
          issue,
          suspectedCause: "General customer service or preference discrepancy.",
          confidence: "POSSIBLE",
        });
        break;
      }
    }
  }

  return correlations;
}
