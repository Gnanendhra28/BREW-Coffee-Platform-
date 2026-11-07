import "server-only";
import { getApps, initializeApp, cert, type App } from "firebase-admin/app";
import { getFirestore, type Firestore, FieldValue, Timestamp } from "firebase-admin/firestore";

/**
 * Authoritative Server-Side Firebase Admin Initialization
 * Strictly server-only. Never imported into client bundles.
 * 
 * Supports:
 * 1. Google Cloud Run / GKE / Compute Engine (Application Default Credentials via ADC)
 * 2. Standalone / Docker / Vercel (FIREBASE_SERVICE_ACCOUNT env var as JSON or base64)
 * 3. Individual credentials env vars (FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY)
 * 4. Graceful error handling and single-instance re-use across Next.js dev reloads
 */

let adminApp: App | null = null;
let adminDb: Firestore | null = null;
let overrideDb: Firestore | null | undefined = undefined;
let initError: string | null = null;

function getProjectId(): string {
  return (
    process.env.FIREBASE_PROJECT_ID ||
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ||
    process.env.GCP_PROJECT ||
    process.env.GCLOUD_PROJECT ||
    "brew-2621e"
  );
}

function initFirebaseAdmin(): App | null {
  if (adminApp) return adminApp;

  const existingApps = getApps();
  if (existingApps.length > 0) {
    adminApp = existingApps[0];
    return adminApp;
  }

  const projectId = getProjectId();

  try {
    // 1. Check for JSON service account in environment
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (serviceAccountJson) {
      let parsedCreds: Record<string, string>;
      try {
        if (serviceAccountJson.trim().startsWith("{")) {
          parsedCreds = JSON.parse(serviceAccountJson);
        } else {
          // Attempt base64 decode
          const decoded = Buffer.from(serviceAccountJson, "base64").toString("utf-8");
          parsedCreds = JSON.parse(decoded);
        }
        adminApp = initializeApp({
          credential: cert(parsedCreds),
          projectId: parsedCreds.project_id || projectId,
        });
        return adminApp;
      } catch (jsonErr) {
        console.warn("[FIREBASE ADMIN] Failed to parse FIREBASE_SERVICE_ACCOUNT credential:", jsonErr);
      }
    }

    // 2. Check for individual private key env vars
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
    if (clientEmail && privateKey) {
      adminApp = initializeApp({
        credential: cert({
          projectId,
          clientEmail,
          privateKey,
        }),
        projectId,
      });
      return adminApp;
    }

    // 3. Fallback to Application Default Credentials (ADC) for Google Cloud Run / GCP environments
    adminApp = initializeApp({
      projectId,
    });
    return adminApp;
  } catch (err) {
    initError = err instanceof Error ? err.message : "Firebase Admin initialization failed";
    console.warn(`[FIREBASE ADMIN] Initialization warning: ${initError}`);
    return null;
  }
}

export function getAdminApp(): App | null {
  if (!adminApp) {
    adminApp = initFirebaseAdmin();
  }
  return adminApp;
}

export function getAdminFirestore(): Firestore | null {
  if (overrideDb !== undefined) return overrideDb;
  if (adminDb) return adminDb;

  const app = getAdminApp();
  if (app) {
    try {
      adminDb = getFirestore(app);
      try {
        adminDb.settings({ ignoreUndefinedProperties: true });
      } catch {}
      return adminDb;
    } catch (e) {
      console.warn("[FIREBASE ADMIN] getFirestore error:", e);
      return null;
    }
  }
  return null;
}

export function isFirebaseAdminAvailable(): boolean {
  return getAdminFirestore() !== null;
}

export function setAdminFirestoreForTesting(db: Firestore | null | undefined): void {
  overrideDb = db;
  adminDb = db ?? null;
}

export { FieldValue, Timestamp };
