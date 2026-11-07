/**
 * BREW Coffee Platform — Phase 6.1 Communication Foundation
 * Barrel export for communication schemas, consent engine, DND rules, policy, and providers.
 */

export * from "./types";
export * from "./schemas";
export * from "./errors";
export * from "./config";
export * from "./consent";
export * from "./dnd";
export * from "./policy";
export * from "./repositories/consentRepository";
export * from "./repositories/firestoreConsentRepository";
export * from "./repositories/dndRepository";
export * from "./repositories/firestoreDndRepository";
export * from "./repositories/repositorySelector";
export * from "./providers/voiceProvider";
export * from "./providers/exotelVoiceProvider";
export * from "./providers/whatsappProvider";
export * from "./providers/metaWhatsAppProvider";
export * from "./providers/whatsappTemplates";
export * from "./providers/whatsappProviderSelector";
export * from "./outbox/outboxModel";
export {
  type CommunicationOutboxRepository,
  type OutboxMetricsSummary,
  type MetricComponentFidelity,
  type OutboxMetricsFidelityBreakdown,
  type FirestoreCommunicationOutboxRepositoryOptions,
  computeOutboxMetricsFromRecords,
  InMemoryCommunicationOutboxRepository,
  FirestoreCommunicationOutboxRepository,
} from "./outbox/outboxRepository";
export * from "./outbox/outboxWorker";
export * from "./outbox/workerAuth";
export * from "./outbox/outboxService";
export * from "./voice";
export * from "./visibility";
