import { NextRequest, NextResponse } from "next/server";
import nodemailer from "nodemailer";
import fs from "fs";
import path from "path";
import crypto from "node:crypto";
import { generateEventQuotation } from "../../../lib/smartAgentsEngine";
import { VanRequestInputSchema } from "../../../lib/agentSchemas";
import { checkRateLimit, getClientIp } from "../../../lib/rateLimit";
import { verifySessionToken } from "../../../lib/authTokens";
import { isSessionRevoked } from "../../../lib/sessionRevocation";
import { maskContact } from "../../../lib/observability/logger";
import { getAdminFirestore } from "../../../lib/firebaseAdmin";
import { readBoundedJson } from "../../../lib/boundedBody";

const BUSINESS_EMAIL = process.env.BUSINESS_EMAIL || "mattag@iitbhilai.ac.in";
const IDEMPOTENCY_FILE_PATH = path.join(process.cwd(), "src/data/idempotency_records.json");

// Idempotency Record Storage with 10-minute sliding window
interface IdempotencyRecord {
  timestamp: number;
  status: "pending" | "completed";
  response?: Record<string, unknown>;
  fingerprint: string;
}

const idempotencyStoreKey = Symbol.for("brew.van_requests.idempotency");
interface GlobalWithIdempotency {
  [idempotencyStoreKey]?: Map<string, IdempotencyRecord>;
}
const g = globalThis as unknown as GlobalWithIdempotency;
if (!g[idempotencyStoreKey]) {
  g[idempotencyStoreKey] = new Map<string, IdempotencyRecord>();
}
const idempotencyStore = g[idempotencyStoreKey]!;

function cleanupIdempotencyStore() {
  const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
  for (const [key, record] of idempotencyStore.entries()) {
    if (record.timestamp < tenMinutesAgo) {
      idempotencyStore.delete(key);
    }
  }
}

function readDurableIdempotency(key: string): IdempotencyRecord | undefined {
  const inMemory = idempotencyStore.get(key);
  if (inMemory) return inMemory;

  try {
    if (fs.existsSync(IDEMPOTENCY_FILE_PATH)) {
      const data = JSON.parse(fs.readFileSync(IDEMPOTENCY_FILE_PATH, "utf-8")) as Record<string, IdempotencyRecord>;
      if (data && data[key]) {
        idempotencyStore.set(key, data[key]);
        return data[key];
      }
    }
  } catch {}
  return undefined;
}

function writeDurableIdempotency(key: string, record: IdempotencyRecord) {
  idempotencyStore.set(key, record);
  try {
    const dir = path.dirname(IDEMPOTENCY_FILE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    let data: Record<string, IdempotencyRecord> = {};
    if (fs.existsSync(IDEMPOTENCY_FILE_PATH)) {
      try {
        data = JSON.parse(fs.readFileSync(IDEMPOTENCY_FILE_PATH, "utf-8"));
      } catch {}
    }
    data[key] = record;
    fs.writeFileSync(IDEMPOTENCY_FILE_PATH, JSON.stringify(data, null, 2), "utf-8");
  } catch {}
}

function removeDurableIdempotency(key: string) {
  idempotencyStore.delete(key);
  try {
    if (fs.existsSync(IDEMPOTENCY_FILE_PATH)) {
      const data = JSON.parse(fs.readFileSync(IDEMPOTENCY_FILE_PATH, "utf-8")) as Record<string, IdempotencyRecord>;
      delete data[key];
      fs.writeFileSync(IDEMPOTENCY_FILE_PATH, JSON.stringify(data, null, 2), "utf-8");
    }
  } catch {}
}

export async function POST(req: NextRequest) {
  try {
    // 1. Stream-bounded body read: enforces strict 100KB limit
    const readResult = await readBoundedJson(req);
    if (!readResult.ok || readResult.response) {
      return readResult.response!;
    }
    const rawBody = readResult.data;

    // 2. IP Rate Limiting (10 requests per 60 seconds per IP, sensitive in production)
    const clientIp = getClientIp(req);
    const rateLimit = await checkRateLimit(clientIp, "van-request", 10, 60, {
      sensitive: true,
    });
    if (!rateLimit.success) {
      if (rateLimit.error === "RATE_LIMITER_UNAVAILABLE") {
        return NextResponse.json(
          { error: "Catering service rate limiter temporarily unavailable. Please retry shortly." },
          { status: 503 }
        );
      }
      return NextResponse.json(
        {
          error: "Too Many Requests. Please wait a moment before submitting another catering enquiry.",
          retryAfterSeconds: Math.max(1, rateLimit.reset - Math.floor(Date.now() / 1000)),
        },
        {
          status: 429,
          headers: {
            "Retry-After": Math.max(1, rateLimit.reset - Math.floor(Date.now() / 1000)).toString(),
          },
        }
      );
    }

    // 4. Strict Zod Schema Validation
    const validationResult = VanRequestInputSchema.safeParse(rawBody);
    if (!validationResult.success) {
      const errorMessages = validationResult.error.issues
        .map((iss) => `${iss.path.join(".") || "field"}: ${iss.message}`)
        .join("; ");
      return NextResponse.json(
        { error: `Validation Error: ${errorMessages}` },
        { status: 400 }
      );
    }

    const {
      contact,
      organization,
      location,
      eventDate,
      crowdSize,
      notes,
      idempotencyKey: clientProvidedKey,
    } = validationResult.data;

    // 5. Server-Side Idempotency Protection
    cleanupIdempotencyStore();

    // Fingerprint combines contact, organization, location, eventDate, crowdSize
    const payloadFingerprint = crypto
      .createHash("sha256")
      .update(
        `${contact.toLowerCase().trim()}|${organization.toLowerCase().trim()}|${location.toLowerCase().trim()}|${eventDate.toLowerCase().trim()}|${String(crowdSize)}`
      )
      .digest("hex");

    const effectiveIdempotencyKey = clientProvidedKey
      ? `client_${clientProvidedKey}`
      : `hash_${payloadFingerprint}`;

    const existingIdempotency = readDurableIdempotency(effectiveIdempotencyKey);
    if (existingIdempotency) {
      // NEVER trust idempotency key alone: verify customer and payload fingerprint match
      if (existingIdempotency.fingerprint !== payloadFingerprint) {
        return NextResponse.json(
          {
            error:
              "Idempotency conflict: Provided key matches an existing transaction with differing payload or customer details.",
          },
          { status: 409 }
        );
      }

      if (existingIdempotency.status === "completed" && existingIdempotency.response) {
        // Return existing quotation idempotently
        return NextResponse.json({
          ...existingIdempotency.response,
          idempotentReplay: true,
        });
      }

      if (existingIdempotency.status === "pending") {
        return NextResponse.json(
          {
            error:
              "A matching catering request is currently being processed. Please wait a moment.",
          },
          { status: 409 }
        );
      }
    }

    // Mark key as pending to prevent concurrent duplicate race conditions
    writeDurableIdempotency(effectiveIdempotencyKey, {
      timestamp: Date.now(),
      status: "pending",
      fingerprint: payloadFingerprint,
    });

    const timestamp = new Date().toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      dateStyle: "full",
      timeStyle: "medium",
    });

    // 6. Generate Deterministic AI Instant Event Quotation (Agent #4)
    const quotation = generateEventQuotation({
      organization,
      location,
      crowdSizeStr: String(crowdSize),
      eventDate,
    });

    const maskedContact = maskContact(contact);
    console.log("==================================================");
    console.log(`🚐 NEW VAN LOCATION REQUEST FOR: ${BUSINESS_EMAIL}`);
    console.log(`Contact: ${maskedContact}`);
    console.log(`Organization/College: ${organization}`);
    console.log(`Target Location: ${location}`);
    console.log(`Preferred Date: ${eventDate}`);
    console.log(`Crowd Estimate: ${crowdSize}`);
    console.log(
      `AI Quote - Recommended Tier: ₹${
        quotation.tiers.find((t) => t.isRecommended)?.totalAmount ||
        quotation.tiers[0].totalAmount
      }`
    );
    console.log(`Received At: ${timestamp}`);
    console.log("==================================================");

    // 7. Prepare Email Notification
    const subject = `🚐 New Van Request: ${organization} (${location}) [AI Quoted]`;
    const textContent = `
NEW MOBILE VAN LOCATION REQUEST
----------------------------------------
Target Email: ${BUSINESS_EMAIL}
Requester Contact: ${contact}
Organization / Campus: ${organization}
Location / City: ${location}
Estimated Date: ${eventDate}
Crowd Size: ${crowdSize}
Notes: ${notes || "None"}
Received: ${timestamp}
----------------------------------------
AI EVENT CONCIERGE INSTANT QUOTATION:
Baristas Assigned: ${quotation.baristasAssigned} crew
Beans Allocation: ${quotation.ingredientAllocation.coffeeBeansKg} kg
Cups Allocation: ${quotation.ingredientAllocation.cupsCount} cups
TIER OPTIONS:
${quotation.tiers
  .map(
    (t) =>
      `• ${t.name} (₹${t.pricePerGuest}/guest) -> Total: ₹${t.totalAmount.toLocaleString(
        "en-IN"
      )} [${t.perks.join(", ")}]`
  )
  .join("\n")}
----------------------------------------
Respond directly to the customer at ${contact}.
`;

    const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #140D08; color: #F4EFE6; margin: 0; padding: 20px; }
    .card { background: #24170F; border: 1px solid #DFAB6C; border-radius: 16px; padding: 28px; max-width: 580px; margin: 0 auto; }
    .header { border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 16px; margin-bottom: 20px; }
    .title { color: #DFAB6C; font-size: 20px; font-weight: bold; margin: 0; }
    .subtitle { color: #8C7C70; font-size: 12px; margin-top: 4px; }
    .row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.05); font-size: 14px; }
    .label { color: #8C7C70; font-weight: 600; }
    .value { color: #FFFFFF; font-weight: bold; text-align: right; }
    .notes-box { background: rgba(0,0,0,0.3); border-radius: 10px; padding: 14px; margin-top: 18px; border: 1px solid rgba(255,255,255,0.08); font-size: 13px; color: #EDE4DA; }
    .footer { margin-top: 24px; padding-top: 14px; border-top: 1px solid rgba(255,255,255,0.1); font-size: 12px; color: #8C7C70; text-align: center; }
    .btn { display: inline-block; background: #DFAB6C; color: #1A110B; padding: 10px 20px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 13px; margin-top: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h2 class="title">☕ BREW — Mobile Van Location Request</h2>
      <p class="subtitle">New customer requesting our outlet on wheels to visit their campus/office</p>
    </div>

    <div class="row">
      <span class="label">Requester Contact:</span>
      <span class="value">${contact}</span>
    </div>

    <div class="row">
      <span class="label">Campus / Office / Host:</span>
      <span class="value">${organization}</span>
    </div>

    <div class="row">
      <span class="label">Requested Location:</span>
      <span class="value">${location}</span>
    </div>

    <div class="row">
      <span class="label">Preferred Date:</span>
      <span class="value">${eventDate}</span>
    </div>

    <div class="row">
      <span class="label">Expected Crowd:</span>
      <span class="value">${crowdSize} (${quotation.estimatedCrowd} guests evaluated)</span>
    </div>

    <div style="margin: 20px 0; padding: 16px; background: rgba(223, 171, 108, 0.08); border: 1px solid rgba(223, 171, 108, 0.25); border-radius: 12px;">
      <h3 style="color: #DFAB6C; font-size: 14px; margin: 0 0 10px 0; text-transform: uppercase; letter-spacing: 1px;">
        🤖 Agent #4 Instant Catering Logistics
      </h3>
      <div class="row">
        <span class="label">Baristas Assigned:</span>
        <span class="value">${quotation.baristasAssigned} Crew</span>
      </div>
      <div class="row">
        <span class="label">Beans Allocation:</span>
        <span class="value">${quotation.ingredientAllocation.coffeeBeansKg} kg</span>
      </div>
      <div class="row">
        <span class="label">Milk Allocation:</span>
        <span class="value">${quotation.ingredientAllocation.milkLiters} Liters</span>
      </div>
      <div class="row">
        <span class="label">Paper Cups Count:</span>
        <span class="value">${quotation.ingredientAllocation.cupsCount} cups</span>
      </div>
      <div class="row">
        <span class="label">Bakery Pastries:</span>
        <span class="value">${quotation.ingredientAllocation.pastriesCount} pieces</span>
      </div>
      <div class="row">
        <span class="label">Power Requirement:</span>
        <span class="value">${quotation.powerRequirement}</span>
      </div>
      <div class="row">
        <span class="label">Operational Service:</span>
        <span class="value">${quotation.vanOperationalHours}</span>
      </div>
    </div>

    <div style="margin-top: 16px;">
      <h3 style="color: #FFFFFF; font-size: 14px; margin-bottom: 8px;">3-Tier Package Quotations:</h3>
      ${quotation.tiers
        .map(
          (t) => `
        <div style="padding: 10px 14px; margin-bottom: 8px; border-radius: 8px; background: ${
          t.isRecommended ? "rgba(16, 185, 129, 0.15)" : "rgba(255, 255, 255, 0.03)"
        }; border: 1px solid ${t.isRecommended ? "#10B981" : "rgba(255, 255, 255, 0.1)"};">
          <div style="display: flex; justify-content: space-between; align-items: baseline;">
            <strong style="color: ${t.isRecommended ? "#10B981" : "#FFFFFF"}; font-size: 13px;">
              ${t.name} ${t.isRecommended ? "★ [RECOMMENDED]" : ""}
            </strong>
            <strong style="color: #DFAB6C; font-size: 14px;">₹${t.totalAmount.toLocaleString(
              "en-IN"
            )} (₹${t.pricePerGuest}/guest)</strong>
          </div>
          <div style="font-size: 11px; color: #A8988B; margin-top: 4px;">
            ${t.perks.join(" • ")}
          </div>
        </div>
      `
        )
        .join("")}
    </div>

    ${
      notes
        ? `<div class="notes-box"><strong>Additional Notes:</strong><br>${notes}</div>`
        : ""
    }

    <div class="footer">
      <p>Business Destination: <strong>${BUSINESS_EMAIL}</strong></p>
      <a href="mailto:${contact}?subject=Re: BREW Mobile Van Request at ${encodeURIComponent(
      organization
    )}" class="btn">Reply to Customer</a>
    </div>
  </div>
</body>
</html>
`;

    // 8. SMTP Transport (Gracefully disabled on Render Free where outbound SMTP ports are blocked)
    const isSmtpDisabled = process.env.DISABLE_SMTP === "true" || process.env.RENDER === "true";
    const smtpHost = isSmtpDisabled ? undefined : process.env.SMTP_HOST;
    const smtpPort = parseInt(process.env.SMTP_PORT || "587", 10);
    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;

    let emailSent = false;
    let emailError: string | null = isSmtpDisabled ? "SMTP delivery disabled for Render free-tier deployment (ports blocked)" : null;

    if (!isSmtpDisabled && smtpHost && smtpUser && smtpPass) {
      try {
        const transporter = nodemailer.createTransport({
          host: smtpHost,
          port: smtpPort,
          secure: smtpPort === 465,
          auth: {
            user: smtpUser,
            pass: smtpPass,
          },
          connectionTimeout: 2000,
          greetingTimeout: 2000,
          socketTimeout: 2500,
        });

        await transporter.sendMail({
          from: `"BREW Van Dispatch" <${smtpUser}>`,
          to: BUSINESS_EMAIL,
          replyTo: contact.includes("@") ? contact : undefined,
          subject,
          text: textContent,
          html: htmlContent,
        });

        emailSent = true;
      } catch (err) {
        emailError = err instanceof Error ? err.message : "SMTP send failed";
        console.error("SMTP delivery error:", emailError);
      }
    }

    // Direct Gmail Web compose URL & standard mailto URL
    const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(
      BUSINESS_EMAIL
    )}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(textContent)}`;

    const mailtoUrl = `mailto:${BUSINESS_EMAIL}?subject=${encodeURIComponent(
      subject
    )}&body=${encodeURIComponent(textContent)}`;

    const requestId = `enq_${payloadFingerprint.slice(0, 32)}`;

    // 9. Authoritative Cloud Firestore Persistence
    let firestorePersisted = false;
    let firestoreError: string | null = null;

    // Check for simulated failure header (for automated resilience testing)
    const simulateDbFailure = req.headers.get("x-simulate-db-failure") === "true";

    const requestRecord = {
      id: requestId,
      contact,
      organization,
      location,
      eventDate,
      crowdSize,
      notes,
      timestamp,
      businessEmail: BUSINESS_EMAIL,
      emailSent,
      quotation,
      status: "pending",
      idempotencyKey: clientProvidedKey || effectiveIdempotencyKey,
      fingerprint: payloadFingerprint,
      createdAt: Date.now(),
    };

    const adminDb = getAdminFirestore();

    if (adminDb && !simulateDbFailure) {
      try {
        const docRef = adminDb.collection("van_requests").doc(requestId);

        // Atomic Transaction: Detect existing enquiry or safely persist fresh record
        const txPromise = adminDb.runTransaction(async (transaction) => {
          const snap = await transaction.get(docRef);
          if (snap.exists) {
            return { exists: true, data: snap.data() };
          }
          transaction.set(docRef, requestRecord);
          return { exists: false, data: requestRecord };
        });

        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Firestore write timed out after 3000ms")), 3000)
        );

        const txResult = await Promise.race([txPromise, timeoutPromise]);
        firestorePersisted = true;

        if (txResult.exists && txResult.data) {
          const cloudData = txResult.data;
          const existingQuote = cloudData.quotation || quotation;
          const cloudResponse = {
            success: true,
            requestId,
            businessEmail: BUSINESS_EMAIL,
            emailSent: Boolean(cloudData.emailSent),
            gmailUrl,
            mailtoUrl,
            quotation: existingQuote,
            requestSummary: {
              contact: cloudData.contact || contact,
              organization: cloudData.organization || organization,
              location: cloudData.location || location,
              timestamp: cloudData.timestamp || timestamp,
            },
            idempotentReplay: true,
          };
          writeDurableIdempotency(effectiveIdempotencyKey, {
            timestamp: Date.now(),
            status: "completed",
            fingerprint: payloadFingerprint,
            response: cloudResponse,
          });
          return NextResponse.json(cloudResponse);
        }
      } catch (fErr) {
        firestoreError = fErr instanceof Error ? fErr.message : "Firestore write failed";
        console.error("Firestore persistence error:", firestoreError);
      }
    } else {
      firestoreError = simulateDbFailure
        ? "Simulated database failure for resilience testing"
        : "Firebase Admin Firestore instance not available or disabled";
    }

    // Strict Production Gate: In production, never claim success unless cloud persistence succeeds
    const isStrictPersistence =
      process.env.NODE_ENV === "production" && process.env.ALLOW_LOCAL_FALLBACK !== "true";

    if ((isStrictPersistence || simulateDbFailure) && !firestorePersisted) {
      removeDurableIdempotency(effectiveIdempotencyKey);
      return NextResponse.json(
        {
          error:
            "Database persistence error: Failed to record catering enquiry in cloud storage. Please try again.",
          details: firestoreError,
        },
        { status: 503 }
      );
    }

    // Non-production safety net: Persist locally for dev/test runner if filesystem is writable
    if (!firestorePersisted) {
      try {
        const filePath = path.join(process.cwd(), "src/data/van_requests.json");
        const dirPath = path.dirname(filePath);
        if (!fs.existsSync(dirPath)) {
          fs.mkdirSync(dirPath, { recursive: true });
        }
        let existing: unknown[] = [];
        if (fs.existsSync(filePath)) {
          try {
            existing = JSON.parse(fs.readFileSync(filePath, "utf-8"));
          } catch {}
        }
        existing.unshift(requestRecord);
        fs.writeFileSync(filePath, JSON.stringify(existing, null, 2), "utf-8");
      } catch {
        // In read-only test environments, silently continue
      }
    }

    // 10. Construct Final Response Payload
    const responsePayload = {
      success: true,
      requestId,
      businessEmail: BUSINESS_EMAIL,
      emailSent,
      emailError,
      gmailUrl,
      mailtoUrl,
      quotation,
      requestSummary: {
        contact,
        organization,
        location,
        timestamp,
      },
    };

    // Store in durable idempotency cache
    writeDurableIdempotency(effectiveIdempotencyKey, {
      timestamp: Date.now(),
      status: "completed",
      response: responsePayload,
      fingerprint: payloadFingerprint,
    });

    return NextResponse.json(responsePayload);
  } catch (error) {
    console.error("Van request handler failed:", error);
    return NextResponse.json(
      { error: "Internal server error processing van request" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/request-van
 * Protected Endpoint: Retrieves all catering enquiries.
 * Strictly restricted to authenticated staff ('barista' or 'fleet_admin') to protect customer PII.
 */
export async function GET(req: NextRequest) {
  try {
    // 1. Authenticate Request via Edge Session Token
    const token = req.cookies.get("brew_session")?.value;
    if (!token) {
      return NextResponse.json(
        { error: "Authentication required. Please log in with staff credentials." },
        { status: 401 }
      );
    }

    const session = await verifySessionToken(token);
    if (
      !session ||
      (session.sid && (await isSessionRevoked(session.sid, session.role, session.expiresAt)))
    ) {
      return NextResponse.json(
        { error: "Authentication required. Please log in with staff credentials." },
        { status: 401 }
      );
    }
    if (session.role !== "barista" && session.role !== "fleet_admin") {
      return NextResponse.json(
        { error: "Forbidden: Staff credentials required to view catering enquiries." },
        { status: 403 }
      );
    }

    // 2. Query Authoritative Firestore Collection via Firebase Admin SDK
    const adminDb = getAdminFirestore();
    let results: unknown[] = [];

    if (adminDb) {
      try {
        const queryPromise = adminDb
          .collection("van_requests")
          .orderBy("createdAt", "desc")
          .limit(100)
          .get();
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Firestore query timed out after 3000ms")), 3000)
        );
        const snapshot = await Promise.race([queryPromise, timeoutPromise]);
        results = snapshot.docs.map((docSnap) => ({
          id: docSnap.id,
          ...docSnap.data(),
        }));
      } catch (fErr) {
        console.warn("Firestore query fallback:", fErr);
      }
    }

    if (results.length > 0) {
      return NextResponse.json(results);
    }

    // Non-production fallback to local file
    const filePath = path.join(process.cwd(), "src/data/van_requests.json");
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      return NextResponse.json(data);
    }

    return NextResponse.json([]);
  } catch (error) {
    console.error("Failed to read van requests:", error);
    return NextResponse.json(
      { error: "Internal error retrieving enquiries" },
      { status: 500 }
    );
  }
}
