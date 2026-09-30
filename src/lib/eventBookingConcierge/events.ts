// Event Dispatcher and Reactive Pipeline Router for Agent 4: 🎪 Event Booking Concierge

import {
  BookingRecord,
} from "./types";
import { processEventInquiry, ConciergeInquiryResult } from "./conciergeAgent";
import { tool_accept_quote } from "./tools";
import { releaseSlot } from "./policy";

export interface ConciergeEvent {
  type:
    | "EVENT_INQUIRY_RECEIVED"
    | "QUOTE_CREATED"
    | "QUOTE_ACCEPTED"
    | "BOOKING_CREATED"
    | "BOOKING_CANCELLED"
    | "RESOURCE_RESERVED";
  timestamp: number;
  payload: Record<string, unknown>;
}

type ConciergeEventListener = (event: ConciergeEvent) => void;
const EVENT_LISTENERS: Set<ConciergeEventListener> = new Set();

export function subscribeToConciergeEvents(listener: ConciergeEventListener): () => void {
  EVENT_LISTENERS.add(listener);
  return () => {
    EVENT_LISTENERS.delete(listener);
  };
}

export function emitConciergeEvent(event: ConciergeEvent): void {
  for (const listener of EVENT_LISTENERS) {
    try {
      listener(event);
    } catch (err) {
      console.error("[EventBookingConcierge] Error in event listener:", err);
    }
  }
}

/**
 * Main reactive handler for incoming catering events.
 */
export function handleConciergeEvent(
  event: ConciergeEvent
): {
  handled: boolean;
  actionTaken: string;
  result?: ConciergeInquiryResult | { booking?: BookingRecord; error?: string };
} {
  emitConciergeEvent(event);

  switch (event.type) {
    case "EVENT_INQUIRY_RECEIVED": {
      const input = (event.payload.inquiryText || event.payload.requirements) as string | Record<string, unknown>;
      const res = processEventInquiry(input, {
        customerId: typeof event.payload.customerId === "string" ? event.payload.customerId : undefined,
      });
      return {
        handled: true,
        actionTaken: res.needsClarification ? "CLARIFICATION_REQUESTED" : "QUOTE_GENERATED",
        result: res,
      };
    }

    case "QUOTE_ACCEPTED": {
      const quoteId = String(event.payload.quoteId || "");
      const selectedTierId = event.payload.selectedTierId as "BASIC" | "STANDARD" | "PREMIUM" | undefined;
      const timeSlot = typeof event.payload.timeSlot === "string" ? event.payload.timeSlot : undefined;

      const acceptRes = tool_accept_quote({
        quoteId,
        selectedTierId,
        timeSlot,
      });

      return {
        handled: true,
        actionTaken: acceptRes.success ? "BOOKING_CONFIRMED" : "ACCEPTANCE_FAILED",
        result: acceptRes,
      };
    }

    case "BOOKING_CANCELLED": {
      const eventDate = typeof event.payload.eventDate === "string" ? event.payload.eventDate : undefined;
      const timeSlot = typeof event.payload.timeSlot === "string" ? event.payload.timeSlot : undefined;
      if (eventDate && timeSlot) {
        releaseSlot(eventDate, timeSlot);
      }
      return {
        handled: true,
        actionTaken: "SLOT_RELEASED",
      };
    }

    default:
      return {
        handled: false,
        actionTaken: "UNKNOWN_EVENT_IGNORED",
      };
  }
}
