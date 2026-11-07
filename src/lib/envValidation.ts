/**
 * BREW Coffee Platform — Production Environment Validation
 *
 * Enforces fail-closed validation of all critical production environment variables
 * and Firebase/Firestore credentials.
 *
 * ZERO-SECRET EXPOSURE GUARANTEE:
 * - Secret values (passwords, private keys, HMAC tokens, PINs) are NEVER logged, printed,
 *   or returned in diagnostic summaries.
 * - Diagnostic errors only specify variable names, required formats, or presence status.
 */

export interface EnvValidationFailure {
  name: string;
  reason: "missing" | "insufficient_length" | "prohibited_default" | "invalid_format";
}

export interface EnvValidationResult {
  valid: boolean;
  isProduction: boolean;
  missingVariables: string[];
  invalidVariables: EnvValidationFailure[];
  errors: string[];
}

export const REQUIRED_PRODUCTION_VARS = [
  "AUTH_SECRET",
  "QUOTATION_SNAPSHOT_SECRET",
  "BARISTA_PIN",
  "FLEET_ADMIN_PIN",
  "OUTBOX_WORKER_SECRET",
  "BUSINESS_EMAIL",
  "NEXT_PUBLIC_BUSINESS_EMAIL",
] as const;

const PROHIBITED_DEFAULT_PINS = new Set(["2026", "7788"]);
const PROHIBITED_DEFAULT_SECRETS = new Set([
  "brew-platform-secure-jwt-hmac-secret-key-2026",
  "brew-test-quotation-secret-32-chars-long!",
]);

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validates whether the application is running in production.
 */
export function isProductionEnvironment(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Validates whether Firestore credentials are fully configured.
 * Supports:
 * 1. FIREBASE_SERVICE_ACCOUNT (valid JSON or base64 JSON)
 * 2. Triplet of FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
 */
export function isFirestoreConfigured(): boolean {
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();
  if (sa) {
    try {
      if (sa.startsWith("{")) {
        JSON.parse(sa);
        return true;
      }
      const decoded = Buffer.from(sa, "base64").toString("utf-8");
      JSON.parse(decoded);
      return true;
    } catch {
      // Malformed service account JSON
      return false;
    }
  }

  const projectId = (
    process.env.FIREBASE_PROJECT_ID ||
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ||
    process.env.GCP_PROJECT
  )?.trim();

  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim();
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.trim();

  if (projectId && clientEmail && privateKey && EMAIL_REGEX.test(clientEmail)) {
    return privateKey.includes("PRIVATE KEY");
  }

  return false;
}

/**
 * Authoritatively validates production environment variables.
 * Safe for execution during startup, healthchecks, and CI.
 * NEVER returns or logs secret values.
 */
export function validateProductionEnvironment(): EnvValidationResult {
  const isProd = isProductionEnvironment();
  const missing: string[] = [];
  const invalid: EnvValidationFailure[] = [];
  const errors: string[] = [];

  if (!isProd) {
    return {
      valid: true,
      isProduction: false,
      missingVariables: [],
      invalidVariables: [],
      errors: [],
    };
  }

  // 1. AUTH_SECRET
  const authSecret = process.env.AUTH_SECRET?.trim();
  if (!authSecret) {
    missing.push("AUTH_SECRET");
    invalid.push({ name: "AUTH_SECRET", reason: "missing" });
    errors.push("AUTH_SECRET is required in production.");
  } else if (authSecret.length < 32) {
    invalid.push({ name: "AUTH_SECRET", reason: "insufficient_length" });
    errors.push("AUTH_SECRET must be at least 32 characters in production.");
  } else if (PROHIBITED_DEFAULT_SECRETS.has(authSecret)) {
    invalid.push({ name: "AUTH_SECRET", reason: "prohibited_default" });
    errors.push("AUTH_SECRET cannot use insecure development default value in production.");
  }

  // 2. QUOTATION_SNAPSHOT_SECRET
  const quoteSecret = process.env.QUOTATION_SNAPSHOT_SECRET?.trim();
  if (!quoteSecret) {
    missing.push("QUOTATION_SNAPSHOT_SECRET");
    invalid.push({ name: "QUOTATION_SNAPSHOT_SECRET", reason: "missing" });
    errors.push("QUOTATION_SNAPSHOT_SECRET is required in production.");
  } else if (quoteSecret.length < 32) {
    invalid.push({ name: "QUOTATION_SNAPSHOT_SECRET", reason: "insufficient_length" });
    errors.push("QUOTATION_SNAPSHOT_SECRET must be at least 32 characters in production.");
  } else if (PROHIBITED_DEFAULT_SECRETS.has(quoteSecret)) {
    invalid.push({ name: "QUOTATION_SNAPSHOT_SECRET", reason: "prohibited_default" });
    errors.push("QUOTATION_SNAPSHOT_SECRET cannot use development test default in production.");
  }

  // 3. BARISTA_PIN
  const baristaPin = process.env.BARISTA_PIN?.trim();
  if (!baristaPin) {
    missing.push("BARISTA_PIN");
    invalid.push({ name: "BARISTA_PIN", reason: "missing" });
    errors.push("BARISTA_PIN is required in production.");
  } else if (PROHIBITED_DEFAULT_PINS.has(baristaPin)) {
    invalid.push({ name: "BARISTA_PIN", reason: "prohibited_default" });
    errors.push("BARISTA_PIN cannot use development default value in production.");
  }

  // 4. FLEET_ADMIN_PIN
  const fleetPin = process.env.FLEET_ADMIN_PIN?.trim();
  if (!fleetPin) {
    missing.push("FLEET_ADMIN_PIN");
    invalid.push({ name: "FLEET_ADMIN_PIN", reason: "missing" });
    errors.push("FLEET_ADMIN_PIN is required in production.");
  } else if (PROHIBITED_DEFAULT_PINS.has(fleetPin)) {
    invalid.push({ name: "FLEET_ADMIN_PIN", reason: "prohibited_default" });
    errors.push("FLEET_ADMIN_PIN cannot use development default value in production.");
  }

  // 5. OUTBOX_WORKER_SECRET
  const workerSecret = process.env.OUTBOX_WORKER_SECRET?.trim();
  if (!workerSecret) {
    missing.push("OUTBOX_WORKER_SECRET");
    invalid.push({ name: "OUTBOX_WORKER_SECRET", reason: "missing" });
    errors.push("OUTBOX_WORKER_SECRET is required in production.");
  } else if (workerSecret.length < 16) {
    invalid.push({ name: "OUTBOX_WORKER_SECRET", reason: "insufficient_length" });
    errors.push("OUTBOX_WORKER_SECRET must be at least 16 characters in production.");
  }

  // 6. Firestore Configuration
  if (!isFirestoreConfigured()) {
    const hasSa = Boolean(process.env.FIREBASE_SERVICE_ACCOUNT?.trim());
    if (!hasSa) {
      if (!process.env.FIREBASE_PROJECT_ID?.trim()) {
        missing.push("FIREBASE_PROJECT_ID");
        invalid.push({ name: "FIREBASE_PROJECT_ID", reason: "missing" });
      }
      if (!process.env.FIREBASE_CLIENT_EMAIL?.trim()) {
        missing.push("FIREBASE_CLIENT_EMAIL");
        invalid.push({ name: "FIREBASE_CLIENT_EMAIL", reason: "missing" });
      }
      if (!process.env.FIREBASE_PRIVATE_KEY?.trim()) {
        missing.push("FIREBASE_PRIVATE_KEY");
        invalid.push({ name: "FIREBASE_PRIVATE_KEY", reason: "missing" });
      }
    } else {
      invalid.push({ name: "FIREBASE_SERVICE_ACCOUNT", reason: "invalid_format" });
    }
    errors.push("Valid Cloud Firestore credentials are required for shared durable persistence in production.");
  }

  // 7. BUSINESS_EMAIL
  const bizEmail = process.env.BUSINESS_EMAIL?.trim();
  if (!bizEmail) {
    missing.push("BUSINESS_EMAIL");
    invalid.push({ name: "BUSINESS_EMAIL", reason: "missing" });
    errors.push("BUSINESS_EMAIL is required in production.");
  } else if (!EMAIL_REGEX.test(bizEmail)) {
    invalid.push({ name: "BUSINESS_EMAIL", reason: "invalid_format" });
    errors.push("BUSINESS_EMAIL must be a valid email format in production.");
  } else if (bizEmail.includes("iitbhilai.ac.in") || bizEmail.includes("localhost")) {
    invalid.push({ name: "BUSINESS_EMAIL", reason: "prohibited_default" });
    errors.push("BUSINESS_EMAIL cannot use personal or development email in production.");
  }

  // 8. NEXT_PUBLIC_BUSINESS_EMAIL
  const pubBizEmail = process.env.NEXT_PUBLIC_BUSINESS_EMAIL?.trim();
  if (!pubBizEmail) {
    missing.push("NEXT_PUBLIC_BUSINESS_EMAIL");
    invalid.push({ name: "NEXT_PUBLIC_BUSINESS_EMAIL", reason: "missing" });
    errors.push("NEXT_PUBLIC_BUSINESS_EMAIL is required in production.");
  } else if (!EMAIL_REGEX.test(pubBizEmail)) {
    invalid.push({ name: "NEXT_PUBLIC_BUSINESS_EMAIL", reason: "invalid_format" });
    errors.push("NEXT_PUBLIC_BUSINESS_EMAIL must be a valid email format in production.");
  }

  const valid = missing.length === 0 && invalid.length === 0;

  return {
    valid,
    isProduction: true,
    missingVariables: missing,
    invalidVariables: invalid,
    errors,
  };
}

/**
 * Fail-closed assertion for production runtime initialization.
 * Throws a clean, safe Error that lists only variable names and never exposes secret values.
 */
export function assertProductionEnvironment(): void {
  const result = validateProductionEnvironment();
  if (!result.valid) {
    const errorList = result.errors.join("; ");
    throw new Error(`[PRODUCTION CONFIGURATION FAILURE] ${errorList}`);
  }
}
