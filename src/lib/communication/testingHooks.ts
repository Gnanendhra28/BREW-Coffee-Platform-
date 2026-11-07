import { CommunicationOutboxRepository } from "./outbox/outboxRepository";
import { OutboxWorker } from "./outbox/outboxWorker";
import { VoiceCallAttemptRepository } from "./voice/types";

// 1. Admin Outbox Metrics Route Overrides
let metricsOutboxRepoOverride: CommunicationOutboxRepository | null = null;
let metricsDbProviderOverride: (() => unknown) | null = null;

export function _setMetricsOutboxRepoForTesting(repo: CommunicationOutboxRepository | null): void {
  metricsOutboxRepoOverride = repo;
}

export function _setMetricsDbProviderForTesting(provider: (() => unknown) | null): void {
  metricsDbProviderOverride = provider;
}

export function getMetricsOutboxRepoOverride(): CommunicationOutboxRepository | null {
  return metricsOutboxRepoOverride;
}

export function getMetricsDbProviderOverride(): (() => unknown) | null {
  return metricsDbProviderOverride;
}

// 2. Cron Outbox Worker Route Overrides
let cronWorkerOverride: OutboxWorker | null = null;
let cronDbProviderOverride: (() => unknown) | null = null;

export function _setCronWorkerForTesting(worker: OutboxWorker | null): void {
  cronWorkerOverride = worker;
}

export function _setCronDbProviderForTesting(provider: (() => unknown) | null): void {
  cronDbProviderOverride = provider;
}

export function getCronWorkerOverride(): OutboxWorker | null {
  return cronWorkerOverride;
}

export function getCronDbProviderOverride(): (() => unknown) | null {
  return cronDbProviderOverride;
}

// 3. Exotel Webhook Route Overrides
let exotelCallAttemptRepoOverride: VoiceCallAttemptRepository | null = null;
let exotelDbProviderOverride: (() => FirebaseFirestore.Firestore | null) | null = null;

export function _setExotelWebhookCallAttemptRepoForTesting(
  repo: VoiceCallAttemptRepository | null
): void {
  exotelCallAttemptRepoOverride = repo;
}

export function _setExotelWebhookDbProviderForTesting(
  provider: (() => FirebaseFirestore.Firestore | null) | null
): void {
  exotelDbProviderOverride = provider;
}

export function getExotelWebhookCallAttemptRepoOverride(): VoiceCallAttemptRepository | null {
  return exotelCallAttemptRepoOverride;
}

export function getExotelWebhookDbProviderOverride(): (() => FirebaseFirestore.Firestore | null) | null {
  return exotelDbProviderOverride;
}

// 4. WhatsApp Webhook Route Overrides
let webhookOutboxRepoOverride: CommunicationOutboxRepository | null = null;
let webhookDbProviderOverride: (() => unknown) | null = null;

export function _setWebhookOutboxRepoForTesting(repo: CommunicationOutboxRepository | null): void {
  webhookOutboxRepoOverride = repo;
}

export function _setWebhookDbProviderForTesting(provider: (() => unknown) | null): void {
  webhookDbProviderOverride = provider;
}

export function getWebhookOutboxRepoOverride(): CommunicationOutboxRepository | null {
  return webhookOutboxRepoOverride;
}

export function getWebhookDbProviderOverride(): (() => unknown) | null {
  return webhookDbProviderOverride;
}
