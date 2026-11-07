/**
 * BREW Coffee Platform — Phase 6.3.4.1 Communication Repository Selector
 * Selects between durable Cloud Firestore and ephemeral in-memory repositories.
 */

import { ConsentRepository, DndRepository } from "../types";
import { InMemoryConsentRepository } from "./consentRepository";
import { FirestoreConsentRepository } from "./firestoreConsentRepository";
import { InMemoryDndRepository } from "./dndRepository";
import { FirestoreDndRepository } from "./firestoreDndRepository";
import { getAdminFirestore } from "../../firebaseAdmin";

export type RepositoryStorageMode = "firestore" | "memory" | "auto";

export function getConsentRepository(
  mode: RepositoryStorageMode = "auto"
): ConsentRepository {
  if (mode === "memory") {
    return new InMemoryConsentRepository();
  }
  if (mode === "firestore") {
    return new FirestoreConsentRepository();
  }
  return getAdminFirestore()
    ? new FirestoreConsentRepository()
    : new InMemoryConsentRepository();
}

export function getDndRepository(
  mode: RepositoryStorageMode = "auto"
): DndRepository {
  if (mode === "memory") {
    return new InMemoryDndRepository();
  }
  if (mode === "firestore") {
    return new FirestoreDndRepository();
  }
  return getAdminFirestore()
    ? new FirestoreDndRepository()
    : new InMemoryDndRepository();
}
