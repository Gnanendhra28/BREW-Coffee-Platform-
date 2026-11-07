/**
 * BREW Coffee Platform — Phase 6.3.3 Communication Outbox Worker
 * Asynchronous, at-least-once transactional outbox processor with atomic claiming,
 * expired lease recovery, dispatch-time policy checks, and provider deduplication.
 */

import {
  CommunicationDeliveryRecord,
  PolicyEvaluationOutcome,
  PolicyEvaluationRequest,
  VoiceProvider,
  WhatsAppProvider,
  WhatsAppTemplateParams,
  VoiceSessionParams,
  VoiceSessionResult,
  ClaimContext,
  MockVoiceCallOutcome,
} from "../types";
import { CommunicationOutboxRepository } from "./outboxRepository";
import { VoiceSessionRepository, isTerminalVoiceState, VoiceBookingSession } from "../../voiceBooking/types";
import { VoiceCallAttemptRepository } from "../voice/types";
import { orchestrateCommunicationPolicy } from "../policy";
import { ConsentRepository, DndRepository } from "../types";
import { ProviderIdempotencyConflictError, StaleClaimError } from "../errors";
import {
  getInitialGreeting,
  processConversationTurn,
} from "../../voiceBooking/conversationEngine";
import { ExtractionProvider } from "../../voiceBooking/types";
import { getEffectiveCallAttemptCount } from "./outboxModel";
import {
  buildBookingConfirmationTemplate,
  buildBookingStatusUpdateTemplate,
  buildBookingReminderTemplate,
} from "../providers/whatsappTemplates";

export interface OutboxWorkerDependencies {
  outboxRepository: CommunicationOutboxRepository;
  sessionRepository: VoiceSessionRepository;
  consentRepository: ConsentRepository;
  dndRepository: DndRepository;
  voiceProvider: VoiceProvider;
  whatsappProvider: WhatsAppProvider;
  extractionProvider?: ExtractionProvider;
  currentTimeProvider?: () => Date;
  callAttemptRepository?: VoiceCallAttemptRepository;
  logger?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

export interface OutboxWorkerOptions {
  workerId?: string;
  leaseDurationMs?: number; // default: 60,000 ms (60 seconds, clamped 5,000 - 300,000 ms)
  batchSize?: number; // default: 10 (clamped 1 - 50)
  backoffBaseMs?: number; // default: 5,000 ms (5s, 10s, 20s...)
}

export interface ProcessCycleOptions {
  deadlineMs?: number;
  minDeliveryHeadroomMs?: number;
}

export interface OutboxCycleResult {
  claimedCount: number;
  dispatchedCount: number;
  blockedCount: number;
  failedCount: number;
  permanentlyFailedCount: number;
}

export class OutboxWorker {
  private dependencies: OutboxWorkerDependencies;
  private options: Required<OutboxWorkerOptions>;

  constructor(
    dependencies: OutboxWorkerDependencies,
    options: OutboxWorkerOptions = {}
  ) {
    this.dependencies = dependencies;

    const rawBatch = options.batchSize ?? 10;
    const clampedBatch = Math.min(
      Math.max(1, Number.isFinite(rawBatch) ? Math.floor(rawBatch) : 10),
      50
    );

    const rawLease = options.leaseDurationMs ?? 60_000;
    const clampedLease = Math.min(
      Math.max(5_000, Number.isFinite(rawLease) ? Math.floor(rawLease) : 60_000),
      300_000
    );

    const rawBackoff = options.backoffBaseMs ?? 5_000;
    const clampedBackoff = Math.min(
      Math.max(1_000, Number.isFinite(rawBackoff) ? Math.floor(rawBackoff) : 5_000),
      60_000
    );

    this.options = {
      workerId:
        options.workerId ||
        `worker_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      leaseDurationMs: clampedLease,
      batchSize: clampedBatch,
      backoffBaseMs: clampedBackoff,
    };
  }

  /**
   * Returns a copy of the active worker configuration options.
   */
  public getOptions(): Readonly<Required<OutboxWorkerOptions>> {
    return { ...this.options };
  }

  /**
   * Reports whether feature flag enforcement is active for this worker instance.
   * In this architecture, all OutboxWorker instances unconditionally enforce
   * the VOICE_BOOKING_ENABLED feature flag.
   */
  public isFeatureFlagEnforced(): boolean {
    return true;
  }

  private getNow(): Date {
    return this.dependencies.currentTimeProvider
      ? this.dependencies.currentTimeProvider()
      : new Date();
  }

  /**
   * Cooperatively releases a claimed delivery back to 'pending' state when insufficient
   * execution-time budget remains to process it during the current worker run.
   */
  public async releaseClaimedDelivery(
    delivery: CommunicationDeliveryRecord,
    now: Date
  ): Promise<void> {
    if (!delivery.claimOwner || !delivery.claimToken || !delivery.claimedAt) {
      return;
    }
    const claimContext: ClaimContext = {
      claimOwner: delivery.claimOwner,
      claimedAt: delivery.claimedAt,
      claimToken: delivery.claimToken,
    };
    const releasedRecord: CommunicationDeliveryRecord = {
      ...delivery,
      status: "pending",
      claimOwner: null,
      claimToken: null,
      claimedAt: null,
      leaseExpiresAt: null,
      updatedAt: now.toISOString(),
    };
    try {
      await this.dependencies.outboxRepository.updateClaimedDelivery(
        releasedRecord,
        claimContext,
        now
      );
      this.dependencies.logger?.info(
        `Released delivery claim for ${delivery.id} back to pending due to time budget headroom.`,
        { deliveryId: delivery.id }
      );
    } catch (err) {
      this.dependencies.logger?.warn(
        `Failed to release delivery claim for ${delivery.id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Executes a single processing cycle of the outbox worker.
   * When deadlineMs is supplied, enforces the execution-time budget cooperatively:
   * - Prevents claiming deliveries if remaining budget < headroom.
   * - Prevents starting new deliveries if remaining budget < headroom.
   * - Releases remaining unstarted claimed deliveries back to 'pending'.
   * 
   * COOPERATIVE DEADLINE BOUNDARY:
   * In Node.js / JavaScript, active in-flight asynchronous operations (e.g. active HTTP network
   * requests or database queries) cannot be preemptively cancelled from the outside.
   * Execution-time deadlines are therefore enforced cooperatively at cycle and delivery boundaries.
   * To prevent an individual provider or database operation from exceeding the overall budget,
   * all external provider dispatches (e.g. MetaWhatsAppProvider's requestTimeoutMs) and database
   * queries MUST maintain strict bounded internal timeouts.
   */
  async processCycle(options?: ProcessCycleOptions): Promise<OutboxCycleResult> {
    const cycleNow = this.getNow();
    const result: OutboxCycleResult = {
      claimedCount: 0,
      dispatchedCount: 0,
      blockedCount: 0,
      failedCount: 0,
      permanentlyFailedCount: 0,
    };

    const minDeliveryHeadroom = options?.minDeliveryHeadroomMs ?? 2000;
    if (options?.deadlineMs && options.deadlineMs - Date.now() < minDeliveryHeadroom) {
      this.dependencies.logger?.warn(
        "Insufficient execution-time budget to start new outbox cycle. Cycle aborted.",
        { remainingMs: options.deadlineMs - Date.now() }
      );
      return result;
    }

    // 1. Atomically claim eligible deliveries
    const claimedDeliveries =
      await this.dependencies.outboxRepository.claimEligibleDeliveries(
        this.options.workerId,
        this.options.leaseDurationMs,
        this.options.batchSize,
        cycleNow
      );

    result.claimedCount = claimedDeliveries.length;

    // 2. Process each claimed delivery sequentially with fresh timestamp
    for (let i = 0; i < claimedDeliveries.length; i++) {
      const delivery = claimedDeliveries[i];

      // Check remaining execution time budget before starting this delivery
      if (options?.deadlineMs) {
        const remainingTime = options.deadlineMs - Date.now();
        if (remainingTime < minDeliveryHeadroom) {
          this.dependencies.logger?.warn(
            `Insufficient execution-time budget (${remainingTime}ms < ${minDeliveryHeadroom}ms) to process delivery ${delivery.id}. Releasing unstarted deliveries in batch.`,
            { remainingMs: remainingTime, deliveryId: delivery.id }
          );
          // Release this delivery and all subsequent unprocessed deliveries in this batch
          for (let j = i; j < claimedDeliveries.length; j++) {
            await this.releaseClaimedDelivery(claimedDeliveries[j], this.getNow());
          }
          break;
        }
      }

      const deliveryNow = this.getNow();
      const outcome = await this.processSingleDelivery(delivery, deliveryNow);
      switch (outcome) {
        case "dispatched":
          result.dispatchedCount++;
          break;
        case "blocked":
          result.blockedCount++;
          break;
        case "failed":
          result.failedCount++;
          break;
        case "permanently_failed":
          result.permanentlyFailedCount++;
          break;
        case "stale_claim_lost":
          // Stale worker lease lost; not counted as an outcome
          break;
      }
    }

    return result;
  }

  /**
   * Safely updates a claimed delivery enforcing lease-ownership verification.
   * If the worker lost its lease or another worker reclaimed it, returns false.
   */
  private async safeUpdateClaimedDelivery(
    delivery: CommunicationDeliveryRecord,
    claimContext: ClaimContext,
    now: Date
  ): Promise<boolean> {
    try {
      await this.dependencies.outboxRepository.updateClaimedDelivery(
        delivery,
        claimContext,
        now
      );
      return true;
    } catch (err) {
      if (err instanceof StaleClaimError) {
        this.dependencies.logger?.warn(
          "Outbox delivery update skipped due to stale claim or expired lease.",
          { deliveryId: delivery.id, claimOwner: claimContext.claimOwner }
        );
        return false;
      }
      throw err;
    }
  }

  /**
   * Verifies whether the worker still holds an active, unexpired claim lease for the delivery.
   * Protects session mutations against stale workers whose lease expired or was reclaimed.
   */
  private async isClaimStillActive(
    deliveryId: string,
    claimContext: ClaimContext,
    now: Date
  ): Promise<boolean> {
    try {
      const record = await this.dependencies.outboxRepository.getDeliveryById(deliveryId);
      if (!record) return false;
      if (record.status !== "processing") return false;
      if (record.claimOwner !== claimContext.claimOwner) return false;
      if (record.claimToken !== claimContext.claimToken) return false;
      if (record.claimedAt !== claimContext.claimedAt) return false;
      if (!record.leaseExpiresAt || new Date(record.leaseExpiresAt).getTime() <= now.getTime()) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Processes a single delivery through session lookup, policy check, and provider dispatch.
   */
  private async processSingleDelivery(
    delivery: CommunicationDeliveryRecord,
    now: Date
  ): Promise<"dispatched" | "blocked" | "failed" | "permanently_failed" | "stale_claim_lost"> {
    const nowIso = now.toISOString();
    const claimContext: ClaimContext = {
      claimOwner: delivery.claimOwner || this.options.workerId,
      claimedAt: delivery.claimedAt || nowIso,
      claimToken: delivery.claimToken || "",
    };

    const effectiveCallAttempts = getEffectiveCallAttemptCount(delivery);

    // 1. Enforce max attempts
    if (effectiveCallAttempts > delivery.maxAttempts) {
      delivery.status = "permanently_failed";
      delivery.lastError = {
        code: "MAX_ATTEMPTS_EXCEEDED",
        message: "MAX_ATTEMPTS_EXCEEDED",
        isRetryable: false,
        occurredAt: nowIso,
        attempt: effectiveCallAttempts,
      };
      delivery.claimOwner = null;
      delivery.claimToken = null;
      delivery.leaseExpiresAt = null;
      delivery.updatedAt = nowIso;
      const updated = await this.safeUpdateClaimedDelivery(delivery, claimContext, now);
      return updated ? "permanently_failed" : "stale_claim_lost";
    }

    // 2. Resolve raw recipient phone number from authoritative voice booking session
    let rawPhoneNumber: string;
    let sessionLanguage = "en";
    let authoritativeSession: VoiceBookingSession;
    try {
      const session = await this.dependencies.sessionRepository.getById(delivery.sessionId);
      if (!session || !session.phoneNumber) {
        delivery.status = "permanently_failed";
        delivery.lastError = {
          code: "SESSION_LOOKUP_FAILED",
          message: "SESSION_LOOKUP_FAILED",
          isRetryable: false,
          occurredAt: nowIso,
          attempt: effectiveCallAttempts,
        };
        delivery.claimOwner = null;
        delivery.claimToken = null;
        delivery.leaseExpiresAt = null;
        delivery.updatedAt = nowIso;
        const updated = await this.safeUpdateClaimedDelivery(delivery, claimContext, now);
        return updated ? "permanently_failed" : "stale_claim_lost";
      }

      authoritativeSession = session;
      rawPhoneNumber = session.phoneNumber;
      sessionLanguage = session.language;
    } catch {
      // Repository failure during session fetch is retryable infrastructure error
      return this.handleFailure(
        delivery,
        claimContext,
        "SESSION_LOOKUP_FAILED",
        true,
        now
      );
    }

    // 3. Dispatch-time consent and DND re-evaluation with fresh timestamp
    const policyTime = this.getNow();
    const policyRequest: PolicyEvaluationRequest = {
      phoneNumber: rawPhoneNumber,
      channel: delivery.channel,
      purpose: delivery.purpose,
      enquiryId: delivery.officialBookingId,
      currentTime: policyTime,
    };

    let policyOutcome: PolicyEvaluationOutcome;
    try {
      policyOutcome = await orchestrateCommunicationPolicy(
        policyRequest,
        {
          consentRepository: this.dependencies.consentRepository,
          dndRepository: this.dependencies.dndRepository,
        },
        {
          checkFeatureFlag: true,
        }
      );
    } catch {
      return this.handleFailure(
        delivery,
        claimContext,
        "POLICY_INFRASTRUCTURE_FAILURE",
        true,
        policyTime
      );
    }

    // 4. Handle Policy Result
    if (policyOutcome.status === "blocked") {
      delivery.status = "blocked";
      delivery.policyResult = {
        status: "blocked",
        reason: policyOutcome.reason,
        details: policyOutcome.details,
        evaluatedAt: policyOutcome.evaluatedAt,
      };
      delivery.claimOwner = null;
      delivery.claimToken = null;
      delivery.leaseExpiresAt = null;
      delivery.updatedAt = policyTime.toISOString();

      // Transactional session mutation guarded by outbox claim lease
      try {
        await this.dependencies.outboxRepository.mutateSessionWithClaimFencing(
          delivery.id,
          claimContext,
          delivery.sessionId,
          policyTime,
          (fresh) => {
            if (!isTerminalVoiceState(fresh.state)) {
              fresh.metadata = {
                ...fresh.metadata,
                callAttemptStatus: "blocked",
                lastAttemptAt: policyTime.toISOString(),
                staffFollowUpRequired: true,
              };
              fresh.updatedAt = policyTime.toISOString();
            }
          },
          this.dependencies.sessionRepository
        );
      } catch (err) {
        if (err instanceof StaleClaimError) {
          return "stale_claim_lost";
        }
        // Non-fatal if session save fails during blocked event recording
      }

      const updated = await this.safeUpdateClaimedDelivery(delivery, claimContext, policyTime);
      return updated ? "blocked" : "stale_claim_lost";
    }

    if (policyOutcome.status === "error") {
      delivery.policyResult = {
        status: "error",
        reason: policyOutcome.reason,
        details: policyOutcome.details,
        evaluatedAt: policyOutcome.evaluatedAt,
      };
      return this.handleFailure(
        delivery,
        claimContext,
        "POLICY_INFRASTRUCTURE_FAILURE",
        true,
        policyTime
      );
    }

    // Policy Allowed
    delivery.policyResult = {
      status: "allowed",
      reason: "ALLOWED",
      details: policyOutcome.details || "Policy checks passed",
      evaluatedAt: policyOutcome.evaluatedAt,
    };

    // 5. Invoke Provider (OUTSIDE of any database transaction)
    try {
      const attemptId =
        delivery.currentAttemptId ||
        `${delivery.id}_call${effectiveCallAttempts || 1}`;

      if (delivery.channel === "whatsapp") {
        let templateParams: WhatsAppTemplateParams;

        try {
          if (
            delivery.templateName === "booking_confirmed_v1" ||
            delivery.eventType === "booking_confirmed"
          ) {
            // 1. Booking Confirmation: exactly 5 parameters
            // [bookingId, eventDate, guestCount, location, tierName]
            const bookingId = (
              delivery.officialBookingId ||
              authoritativeSession.officialBookingId ||
              (delivery.templateParams?.bookingId as string)
            )?.trim();

            const eventDate = (
              authoritativeSession.requirements?.eventDate ||
              (delivery.templateParams?.eventDate as string)
            )?.trim();

            const guestCount =
              authoritativeSession.requirements?.guestCount ??
              (typeof delivery.templateParams?.guestCount === "number"
                ? delivery.templateParams.guestCount
                : Number(delivery.templateParams?.guestCount));

            const location = (
              authoritativeSession.requirements?.venueAddress ||
              (delivery.templateParams?.location as string) ||
              (delivery.templateParams?.venueAddress as string)
            )?.trim();

            const rawTier =
              authoritativeSession.requirements?.selectedTier ||
              authoritativeSession.quotation?.selectedTier ||
              (delivery.templateParams?.tierName as string);
            const tierName = typeof rawTier === "string" ? rawTier.trim() : String(rawTier || "").trim();

            if (
              !bookingId ||
              !eventDate ||
              typeof guestCount !== "number" ||
              guestCount <= 0 ||
              !Number.isFinite(guestCount) ||
              !location ||
              !tierName
            ) {
              return this.handleFailure(
                delivery,
                claimContext,
                "MISSING_AUTHORITATIVE_BOOKING_DETAILS: Confirmation template requires non-empty bookingId, eventDate, positive guestCount, location, and tierName",
                false,
                now
              );
            }

            templateParams = buildBookingConfirmationTemplate({
              to: rawPhoneNumber,
              bookingId,
              eventDate,
              guestCount,
              location,
              tierName,
              language: delivery.templateLanguage || sessionLanguage,
              idempotencyKey: attemptId,
            });
          } else if (
            delivery.templateName === "booking_reminder_v1" ||
            delivery.eventType === "booking_reminder"
          ) {
            // 2. Booking Reminder: exactly 4 parameters
            // [bookingId, eventDate, startTime, location]
            const bookingId = (
              delivery.officialBookingId ||
              authoritativeSession.officialBookingId ||
              (delivery.templateParams?.bookingId as string)
            )?.trim();

            const eventDate = (
              authoritativeSession.requirements?.eventDate ||
              (delivery.templateParams?.eventDate as string)
            )?.trim();

            const startTime = (
              authoritativeSession.requirements?.startTime ||
              (delivery.templateParams?.startTime as string)
            )?.trim();

            const location = (
              authoritativeSession.requirements?.venueAddress ||
              (delivery.templateParams?.location as string) ||
              (delivery.templateParams?.venueAddress as string)
            )?.trim();

            if (!bookingId || !eventDate || !startTime || !location) {
              return this.handleFailure(
                delivery,
                claimContext,
                "MISSING_AUTHORITATIVE_BOOKING_DETAILS: Reminder template requires non-empty bookingId, eventDate, startTime, and location",
                false,
                now
              );
            }

            templateParams = buildBookingReminderTemplate({
              to: rawPhoneNumber,
              bookingId,
              eventDate,
              startTime,
              location,
              language: delivery.templateLanguage || sessionLanguage,
              idempotencyKey: attemptId,
            });
          } else {
            // 3. Status Updates: exactly 3 parameters
            // [bookingId, status, details]
            const bookingId = (
              delivery.officialBookingId ||
              authoritativeSession.officialBookingId ||
              delivery.sessionId
            )?.trim();

            let statusText = (delivery.templateParams?.status as string)?.trim();
            if (!statusText) {
              switch (delivery.eventType) {
                case "booking_awaiting_staff_approval":
                  statusText = "Under Review";
                  break;
                case "booking_cancelled":
                  statusText = "Cancelled";
                  break;
                case "booking_declined":
                  statusText = "Declined";
                  break;
                case "booking_human_handoff":
                  statusText = "Staff Follow-Up";
                  break;
                default:
                  statusText = authoritativeSession.state
                    ? authoritativeSession.state.replace(/_/g, " ")
                    : "Updated";
              }
            }

            let detailsText = (delivery.templateParams?.details as string)?.trim();
            if (!detailsText) {
              switch (delivery.eventType) {
                case "booking_awaiting_staff_approval":
                  detailsText = "Your event booking request is currently being reviewed by our events team.";
                  break;
                case "booking_cancelled":
                  detailsText = "Your event booking request has been cancelled.";
                  break;
                case "booking_declined":
                  detailsText = "Your event booking request could not be accommodated at this time.";
                  break;
                case "booking_human_handoff":
                  detailsText = "Your request has been routed to our concierge team for personal assistance.";
                  break;
                default:
                  detailsText = "Your booking request status has been updated.";
              }
            }

            if (!bookingId || !statusText || !detailsText) {
              return this.handleFailure(
                delivery,
                claimContext,
                "MISSING_AUTHORITATIVE_BOOKING_DETAILS: Status update template requires non-empty bookingId, status, and details",
                false,
                now
              );
            }

            const templateName = delivery.templateName || "booking_status_update_v1";

            templateParams = {
              ...buildBookingStatusUpdateTemplate({
                to: rawPhoneNumber,
                bookingId,
                status: statusText,
                details: detailsText,
                language: delivery.templateLanguage || sessionLanguage,
                idempotencyKey: attemptId,
              }),
              templateName,
            };
          }
        } catch (templateBuildErr) {
          return this.handleFailure(
            delivery,
            claimContext,
            `TEMPLATE_BUILD_ERROR: ${templateBuildErr instanceof Error ? templateBuildErr.message : String(templateBuildErr)}`,
            false,
            now
          );
        }

        const sendResult =
          await this.dependencies.whatsappProvider.sendTemplate(templateParams);

        const dispatchTime = this.getNow();
        const dispatchIso = dispatchTime.toISOString();

        delivery.status = "dispatched";
        delivery.providerResult = {
          providerMessageId: sendResult.messageId,
          status: sendResult.status,
          isSimulated: sendResult.isSimulated,
          providerMode: sendResult.providerMode,
          completedAt: dispatchIso,
        };
        delivery.claimOwner = null;
        delivery.claimToken = null;
        delivery.leaseExpiresAt = null;
        delivery.updatedAt = dispatchIso;
        const updated = await this.safeUpdateClaimedDelivery(delivery, claimContext, dispatchTime);
        return updated ? "dispatched" : "stale_claim_lost";
      } else {
        // Voice dispatch with durable call attempt foundation & asynchronous lifecycle (Phase 6.6.1 & 6.6.1.1)
        const internalAttemptId = delivery.currentAttemptId || `att_${delivery.id}_${effectiveCallAttempts}`;
        const dispatchTime = this.getNow();
        const dispatchIso = dispatchTime.toISOString();

        // 1. Guard against duplicate initiation: check if attempt already registered with an active/uncertain state
        if (this.dependencies.callAttemptRepository) {
          const existingAttempt = await this.dependencies.callAttemptRepository.getById(internalAttemptId);
          if (existingAttempt) {
            // Case A: Attempt already has provider acceptance (accepted or attached providerCallId).
            // The carrier accepted this call. NEVER re-invoke provider API!
            if (existingAttempt.initiationState === "accepted" || existingAttempt.providerCallId) {
              delivery.status = "dispatched";
              delivery.providerResult = {
                providerCallId: existingAttempt.providerCallId || undefined,
                status: existingAttempt.status,
                isSimulated: true,
                providerMode: "recovered",
                completedAt: dispatchIso,
              };
              delivery.claimOwner = null;
              delivery.claimToken = null;
              delivery.leaseExpiresAt = null;
              delivery.updatedAt = dispatchIso;

              const updated = await this.safeUpdateClaimedDelivery(delivery, claimContext, dispatchTime);
              return updated ? "dispatched" : "stale_claim_lost";
            }

            // Case B: Attempt outcome was previously uncertain (e.g. carrier request timed out / network lost).
            // DO NOT automatically redial an uncertain attempt to prevent duplicate outbound calls!
            if (existingAttempt.initiationState === "uncertain") {
              delivery.status = "permanently_failed";
              delivery.nextRetryAt = null; // Block automatic redial
              delivery.lastError = {
                code: "INITIATION_UNCERTAIN",
                message: "Call initiation outcome is uncertain. Automated redial prevented to avoid duplicate calls.",
                isRetryable: false,
                occurredAt: dispatchIso,
                attempt: effectiveCallAttempts,
              };
              delivery.claimOwner = null;
              delivery.claimToken = null;
              delivery.leaseExpiresAt = null;
              delivery.updatedAt = dispatchIso;

              try {
                await this.dependencies.outboxRepository.mutateSessionWithClaimFencing(
                  delivery.id,
                  claimContext,
                  delivery.sessionId,
                  dispatchTime,
                  (session) => {
                    if (!isTerminalVoiceState(session.state)) {
                      session.metadata = {
                        ...session.metadata,
                        callAttemptStatus: "uncertain",
                        lastAttemptAt: dispatchIso,
                        staffFollowUpRequired: true,
                      };
                      session.updatedAt = dispatchIso;
                    }
                  },
                  this.dependencies.sessionRepository
                );
              } catch {
                // Non-fatal
              }

              const updated = await this.safeUpdateClaimedDelivery(delivery, claimContext, dispatchTime);
              return updated ? "permanently_failed" : "stale_claim_lost";
            }

            // Case C: Attempt is currently in_flight
            if (existingAttempt.initiationState === "in_flight") {
              const isLeaseActive =
                existingAttempt.leaseExpiresAt &&
                new Date(existingAttempt.leaseExpiresAt).getTime() > dispatchTime.getTime();

              if (isLeaseActive) {
                // Another active worker owns this in-flight attempt
                if (existingAttempt.claimOwner && existingAttempt.claimOwner !== this.options.workerId) {
                  return "stale_claim_lost";
                }
              } else {
                // The in-flight lease has expired without persisted provider acceptance or rejection!
                // Atomically transition attempt to uncertain to prevent duplicate outbound calls
                await this.dependencies.callAttemptRepository.recoverExpiredInitiation(
                  internalAttemptId,
                  dispatchTime,
                  "Initiation lease expired without persisted outcome; quarantined to uncertain"
                );

                // Quarantined to permanently_failed, prevent automated redial
                delivery.status = "permanently_failed";
                delivery.nextRetryAt = null;
                delivery.lastError = {
                  code: "EXPIRED_INITIATION_LEASE",
                  message:
                    "In-flight initiation claim expired without persisted provider outcome. Quarantined to uncertain to prevent duplicate calls.",
                  isRetryable: false,
                  occurredAt: dispatchIso,
                  attempt: effectiveCallAttempts,
                };
                delivery.claimOwner = null;
                delivery.claimToken = null;
                delivery.leaseExpiresAt = null;
                delivery.updatedAt = dispatchIso;

                try {
                  await this.dependencies.outboxRepository.mutateSessionWithClaimFencing(
                    delivery.id,
                    claimContext,
                    delivery.sessionId,
                    dispatchTime,
                    (session) => {
                      if (!isTerminalVoiceState(session.state)) {
                        session.metadata = {
                          ...session.metadata,
                          callAttemptStatus: "uncertain",
                          lastAttemptAt: dispatchIso,
                          staffFollowUpRequired: true,
                        };
                        session.updatedAt = dispatchIso;
                      }
                    },
                    this.dependencies.sessionRepository
                  );
                } catch {
                  // Non-fatal
                }

                const updated = await this.safeUpdateClaimedDelivery(delivery, claimContext, dispatchTime);
                return updated ? "permanently_failed" : "stale_claim_lost";
              }
            }
          }
        }

        // 2. Create or update call attempt in 'in_flight' state BEFORE provider API request
        if (this.dependencies.callAttemptRepository) {
          try {
            await this.dependencies.callAttemptRepository.createAttempt({
              id: internalAttemptId,
              deliveryId: delivery.id,
              sessionId: delivery.sessionId,
              phoneNumberMasked: delivery.phoneNumberMasked,
              provider: this.dependencies.voiceProvider.providerName,
              claimOwner: this.options.workerId,
              claimToken: claimContext.claimToken,
              leaseExpiresAt: delivery.leaseExpiresAt,
              initiationState: "in_flight",
              initiatedAt: dispatchIso,
            });
          } catch {
            // Safe non-fatal if attempt already registered
          }
        }

        const voiceParams: VoiceSessionParams = {
          sessionId: delivery.sessionId,
          phoneNumber: rawPhoneNumber,
          language: (delivery.templateLanguage || sessionLanguage) as "en" | "hi" | "te",
          enquiryId: delivery.officialBookingId,
          idempotencyKey: internalAttemptId, // Deterministic attempt key
        };

        let sessionResult: VoiceSessionResult;
        try {
          sessionResult = await this.dependencies.voiceProvider.startSession(voiceParams);
        } catch (err: unknown) {
          // If the provider call throws (timeout, network disconnection, HTTP 504),
          // the outcome is uncertain. We must mark the attempt as uncertain and block automated redial!
          const isTimeoutOrNetwork =
            err instanceof Error &&
            (err.name === "AbortError" ||
              err.name === "TimeoutError" ||
              err.message.toLowerCase().includes("timeout") ||
              err.message.toLowerCase().includes("econnreset") ||
              err.message.toLowerCase().includes("etimedout") ||
              err.message.toLowerCase().includes("gateway timeout") ||
              err.message.toLowerCase().includes("network"));

          if (this.dependencies.callAttemptRepository) {
            if (isTimeoutOrNetwork) {
              await this.dependencies.callAttemptRepository
                .markInitiationUncertain(
                  internalAttemptId,
                  "PROVIDER_TIMEOUT",
                  err instanceof Error ? err.message : "Provider request timed out with uncertain outcome",
                  dispatchIso
                )
                .catch(() => {});
            } else {
              await this.dependencies.callAttemptRepository
                .markInitiationRejected(
                  internalAttemptId,
                  "PROVIDER_REJECTED",
                  err instanceof Error ? err.message : "Provider rejected call request",
                  dispatchIso
                )
                .catch(() => {});
            }
          }

          if (isTimeoutOrNetwork) {
            delivery.status = "permanently_failed";
            delivery.nextRetryAt = null; // No automated redial without reconciliation
            delivery.lastError = {
              code: "INITIATION_UNCERTAIN",
              message: "Call initiation outcome is uncertain. Automated redial prevented to avoid duplicate calls.",
              isRetryable: false,
              occurredAt: dispatchIso,
              attempt: effectiveCallAttempts,
            };
            delivery.claimOwner = null;
            delivery.claimToken = null;
            delivery.leaseExpiresAt = null;
            delivery.updatedAt = dispatchIso;

            try {
              await this.dependencies.outboxRepository.mutateSessionWithClaimFencing(
                delivery.id,
                claimContext,
                delivery.sessionId,
                dispatchTime,
                (session) => {
                  if (!isTerminalVoiceState(session.state)) {
                    session.metadata = {
                      ...session.metadata,
                      callAttemptStatus: "uncertain",
                      lastAttemptAt: dispatchIso,
                      staffFollowUpRequired: true,
                    };
                    session.updatedAt = dispatchIso;
                  }
                },
                this.dependencies.sessionRepository
              );
            } catch {
              // Non-fatal
            }

            const updated = await this.safeUpdateClaimedDelivery(delivery, claimContext, dispatchTime);
            return updated ? "permanently_failed" : "stale_claim_lost";
          }

          return this.handleFailure(delivery, claimContext, "PROVIDER_CALL_FAILED", true, dispatchTime);
        }

        // 3. Attach providerCallId and mark initiation accepted upon acceptance
        if (this.dependencies.callAttemptRepository && sessionResult.providerCallId) {
          try {
            await this.dependencies.callAttemptRepository.markInitiationAccepted(
              internalAttemptId,
              sessionResult.providerCallId,
              dispatchIso
            );
          } catch {
            // Safe non-fatal
          }
        }

        // 3. Asynchronous Voice Call Completion (Phase 6.6.1):
        // If provider is asynchronous or returns acceptance without synchronous outcome,
        // complete outbox delivery immediately in < 2s; NEVER hold claim lease during live PSTN call.
        const isAsyncDispatch =
          this.dependencies.voiceProvider.isAsynchronous === true ||
          (!sessionResult.callOutcome &&
            (sessionResult.status === "initiated" || sessionResult.status === "simulated_initiated"));

        if (isAsyncDispatch) {
          delivery.status = "dispatched";
          delivery.providerResult = {
            providerCallId: sessionResult.providerCallId,
            status: sessionResult.status,
            isSimulated: sessionResult.isSimulated,
            providerMode: sessionResult.providerMode,
            completedAt: dispatchIso,
          };
          delivery.claimOwner = null;
          delivery.claimToken = null;
          delivery.leaseExpiresAt = null;
          delivery.updatedAt = dispatchIso;

          // Update safe visibility metadata on session
          try {
            await this.dependencies.outboxRepository.mutateSessionWithClaimFencing(
              delivery.id,
              claimContext,
              delivery.sessionId,
              dispatchTime,
              (session) => {
                if (!isTerminalVoiceState(session.state)) {
                  session.metadata = {
                    ...session.metadata,
                    callAttemptStatus: "initiated",
                    lastAttemptAt: dispatchIso,
                    attemptCount: effectiveCallAttempts,
                    providerCallId: sessionResult.providerCallId,
                  };
                  session.updatedAt = dispatchIso;
                }
              },
              this.dependencies.sessionRepository
            );
          } catch {
            // Non-fatal if session update fails
          }

          const updated = await this.safeUpdateClaimedDelivery(delivery, claimContext, dispatchTime);
          return updated ? "dispatched" : "stale_claim_lost";
        }

        const callOutcome: MockVoiceCallOutcome = sessionResult.callOutcome || "answered";

        if (callOutcome === "answered") {
          if (this.dependencies.callAttemptRepository) {
            await this.dependencies.callAttemptRepository.updateStatus(internalAttemptId, {
              status: "answered",
              timestamp: dispatchIso,
            }).catch(() => {});
          }

          // 1. Authoritative session verification
          try {
            const freshSession = await this.dependencies.sessionRepository.getById(delivery.sessionId);
            const isCancelledOrDeclined =
              !freshSession ||
              freshSession.state === "cancelled" ||
              freshSession.state === "customer_declined" ||
              freshSession.state === "failed";

            if (!freshSession || isCancelledOrDeclined) {
              return this.handleFailure(
                delivery,
                claimContext,
                "SESSION_INELIGIBLE_FOR_CALL",
                false,
                dispatchTime,
                {
                  providerCallId: sessionResult.providerCallId,
                  status: "simulated_failed",
                  callOutcome: "failed",
                  isSimulated: sessionResult.isSimulated,
                  providerMode: sessionResult.providerMode,
                  completedAt: dispatchIso,
                }
              );
            }

            // 2. Transactional session mutation guarded by outbox claim lease
            await this.dependencies.outboxRepository.mutateSessionWithClaimFencing(
              delivery.id,
              claimContext,
              delivery.sessionId,
              dispatchTime,
              (session) => {
                if (!isTerminalVoiceState(session.state)) {
                  const hasGreeting = session.conversationHistory.some(
                    (m) => m.id === `msg_a_${session.id}_init` || (m.role === "assistant" && session.state === "created")
                  );
                  if (session.state === "created" && !hasGreeting) {
                    const greeting = getInitialGreeting(session.language);
                    session.conversationHistory.push({
                      id: `msg_a_${session.id}_init`,
                      role: "assistant",
                      content: greeting,
                      language: session.language,
                      timestamp: dispatchIso,
                    });
                  }

                  // Update safe visibility metadata on session
                  session.metadata = {
                    ...session.metadata,
                    callAttemptStatus: "answered",
                    lastAttemptAt: dispatchIso,
                    attemptCount: effectiveCallAttempts,
                    staffFollowUpRequired: false,
                    callAnsweredAt: dispatchIso,
                    providerCallId: sessionResult.providerCallId,
                  };
                  session.updatedAt = dispatchIso;
                }
              },
              this.dependencies.sessionRepository
            );

            // 3. Process simulated customer conversation turns if configured on provider
            const provider = this.dependencies.voiceProvider;
            if (typeof provider.getSimulatedCustomerTurns === "function") {
              const customerTurns = provider.getSimulatedCustomerTurns(delivery.sessionId);
              if (Array.isArray(customerTurns) && customerTurns.length > 0) {
                for (let i = 0; i < customerTurns.length; i++) {
                  const utterance = customerTurns[i];
                  const currentSession = await this.dependencies.sessionRepository.getById(delivery.sessionId);
                  if (
                    !currentSession ||
                    isTerminalVoiceState(currentSession.state) ||
                    currentSession.state === "awaiting_staff_approval"
                  ) {
                    break;
                  }

                  const turnId = `${currentSession.id}_turn_${i}`;
                  const isTurnAlreadyProcessed =
                    (Array.isArray(currentSession.processedTurnIds) && currentSession.processedTurnIds.includes(turnId)) ||
                    (typeof currentSession.lastProcessedTurnIndex === "number" && currentSession.lastProcessedTurnIndex >= i) ||
                    currentSession.conversationHistory.some((m) => m.id === `msg_u_${turnId}`);

                  if (isTurnAlreadyProcessed) {
                    continue; // Skip already completed turn and resume at first unprocessed
                  }

                  await processConversationTurn(currentSession, utterance, {
                    sessionRepository: this.dependencies.sessionRepository,
                    extractionProvider: this.dependencies.extractionProvider,
                    turnIndex: i,
                    turnId,
                    claimFencing: {
                      outboxRepository: this.dependencies.outboxRepository,
                      deliveryId: delivery.id,
                      claimContext,
                      now: this.getNow(),
                    },
                  });
                }
              }
            }
          } catch (err) {
            if (err instanceof StaleClaimError) {
              return "stale_claim_lost";
            }
            return this.handleFailure(
              delivery,
              claimContext,
              "SESSION_PERSISTENCE_FAILED",
              true,
              dispatchTime,
              {
                providerCallId: sessionResult.providerCallId,
                status: "simulated_answered",
                callOutcome: "answered",
                isSimulated: sessionResult.isSimulated,
                providerMode: sessionResult.providerMode,
                completedAt: dispatchIso,
              }
            );
          }

          delivery.status = "dispatched";
          delivery.providerResult = {
            providerCallId: sessionResult.providerCallId,
            status: "simulated_answered",
            callOutcome: "answered",
            isSimulated: sessionResult.isSimulated,
            providerMode: sessionResult.providerMode,
            completedAt: dispatchIso,
          };
          delivery.claimOwner = null;
          delivery.claimToken = null;
          delivery.leaseExpiresAt = null;
          delivery.updatedAt = dispatchIso;
          const updated = await this.safeUpdateClaimedDelivery(delivery, claimContext, dispatchTime);
          return updated ? "dispatched" : "stale_claim_lost";
        }

        // Unanswered, busy, or failed call outcomes
        const errorCode =
          callOutcome === "no_answer"
            ? "CALL_NO_ANSWER"
            : callOutcome === "busy"
            ? "CALL_BUSY"
            : "CALL_FAILED";

        const providerStatus =
          callOutcome === "no_answer"
            ? "simulated_no_answer"
            : callOutcome === "busy"
            ? "simulated_busy"
            : "simulated_failed";

        if (this.dependencies.callAttemptRepository) {
          const attemptStatus =
            callOutcome === "no_answer" ? "no_answer" : callOutcome === "busy" ? "busy" : "failed";
          await this.dependencies.callAttemptRepository
            .updateStatus(internalAttemptId, {
              status: attemptStatus,
              timestamp: dispatchIso,
              errorCode,
            })
            .catch(() => {});
        }

        // Transactional session mutation guarded by outbox claim lease
        try {
          await this.dependencies.outboxRepository.mutateSessionWithClaimFencing(
            delivery.id,
            claimContext,
            delivery.sessionId,
            dispatchTime,
            (session) => {
              if (!isTerminalVoiceState(session.state)) {
                session.metadata = {
                  ...session.metadata,
                  callAttemptStatus: callOutcome,
                  lastAttemptAt: dispatchIso,
                  attemptCount: effectiveCallAttempts,
                  staffFollowUpRequired: effectiveCallAttempts >= delivery.maxAttempts,
                };
                session.updatedAt = dispatchIso;
              }
            },
            this.dependencies.sessionRepository
          );
        } catch (err) {
          if (err instanceof StaleClaimError) {
            return "stale_claim_lost";
          }
          // Non-fatal if session save fails during failure recording
        }

        return this.handleFailure(
          delivery,
          claimContext,
          errorCode,
          true,
          dispatchTime,
          {
            providerCallId: sessionResult.providerCallId,
            status: providerStatus,
            callOutcome,
            isSimulated: sessionResult.isSimulated,
            providerMode: sessionResult.providerMode,
            completedAt: dispatchIso,
          }
        );
      }
    } catch (providerErr) {
      const errTime = this.getNow();

      if (providerErr instanceof ProviderIdempotencyConflictError) {
        // Idempotency conflict is a non-retryable terminal failure
        return this.handleFailure(
          delivery,
          claimContext,
          "PROVIDER_IDEMPOTENCY_CONFLICT",
          false,
          errTime
        );
      }

      // Provider failures: check if provider explicitly indicated whether the error is retryable
      const isRetryable =
        typeof (providerErr as { isRetryable?: boolean })?.isRetryable === "boolean"
          ? (providerErr as { isRetryable?: boolean }).isRetryable!
          : true;

      const errorCode =
        typeof (providerErr as { code?: string })?.code === "string"
          ? (providerErr as { code?: string }).code!
          : "PROVIDER_DISPATCH_FAILED";

      return this.handleFailure(
        delivery,
        claimContext,
        errorCode,
        isRetryable,
        errTime
      );
    }
  }

  /**
   * Handles failure recording, backoff computation, and permanent failure thresholding.
   * Persists only sanitized error codes; never leaks raw exception messages or credentials.
   */
  private async handleFailure(
    delivery: CommunicationDeliveryRecord,
    claimContext: ClaimContext,
    errorCode: string,
    isRetryable: boolean,
    now: Date,
    providerResult?: CommunicationDeliveryRecord["providerResult"]
  ): Promise<"failed" | "permanently_failed" | "stale_claim_lost"> {
    const nowIso = now.toISOString();
    const effectiveCallAttempts = getEffectiveCallAttemptCount(delivery);
    const attemptsExhausted = effectiveCallAttempts >= delivery.maxAttempts;

    if (providerResult) {
      delivery.providerResult = providerResult;
    }

    if (!isRetryable || attemptsExhausted) {
      delivery.status = "permanently_failed";
      delivery.lastError = {
        code: errorCode,
        message: errorCode,
        isRetryable: false,
        occurredAt: nowIso,
        attempt: effectiveCallAttempts,
      };
      delivery.claimOwner = null;
      delivery.claimToken = null;
      delivery.leaseExpiresAt = null;
      delivery.updatedAt = nowIso;
      const updated = await this.safeUpdateClaimedDelivery(delivery, claimContext, now);
      return updated ? "permanently_failed" : "stale_claim_lost";
    }

    // Compute exponential backoff: base * 2^(effectiveCallAttempts - 1)
    const backoffMs =
      this.options.backoffBaseMs * Math.pow(2, Math.max(0, effectiveCallAttempts - 1));
    const nextRetry = new Date(now.getTime() + backoffMs).toISOString();

    delivery.status = "failed";
    delivery.nextRetryAt = nextRetry;
    delivery.lastError = {
      code: errorCode,
      message: errorCode,
      isRetryable: true,
      occurredAt: nowIso,
      attempt: effectiveCallAttempts,
    };
    delivery.claimOwner = null;
    delivery.claimToken = null;
    delivery.leaseExpiresAt = null;
    delivery.updatedAt = nowIso;
    const updated = await this.safeUpdateClaimedDelivery(delivery, claimContext, now);
    return updated ? "failed" : "stale_claim_lost";
  }
}
