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
  const isProd = process.env.NODE_ENV === "production";
  if (mode === "memory") {
    if (isProd) {
      throw new Error("InMemoryConsentRepository is strictly prohibited in production environment.");
    }
    return new InMemoryConsentRepository();
  }
  if (mode === "firestore" || isProd) {
    return new FirestoreConsentRepository();
  }
  return getAdminFirestore()
    ? new FirestoreConsentRepository()
    : new InMemoryConsentRepository();
}

export function getDndRepository(
  mode: RepositoryStorageMode = "auto"
): DndRepository {
  const isProd = process.env.NODE_ENV === "production";
  if (mode === "memory") {
    if (isProd) {
      throw new Error("InMemoryDndRepository is strictly prohibited in production environment.");
    }
    return new InMemoryDndRepository();
  }
  if (mode === "firestore" || isProd) {
    return new FirestoreDndRepository();
  }
  return getAdminFirestore()
    ? new FirestoreDndRepository()
    : new InMemoryDndRepository();
}
