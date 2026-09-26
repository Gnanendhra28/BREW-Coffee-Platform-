import { NextRequest, NextResponse } from "next/server";
import nodemailer from "nodemailer";
import fs from "fs";
import path from "path";
import { generateEventQuotation } from "@/lib/smartAgentsEngine";

const BUSINESS_EMAIL = process.env.BUSINESS_EMAIL || "mattag@iitbhilai.ac.in";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      contact,
      organization = "Campus / Organization",
      location = "Not Specified",
      eventDate = "Flexible",
      crowdSize = "Not Specified",
      notes = "",
    } = body;

    if (!contact || typeof contact !== "string" || !contact.trim()) {
      return NextResponse.json(
        { error: "A valid email or phone number is required" },
        { status: 400 }
      );
    }

    const timestamp = new Date().toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      dateStyle: "full",
      timeStyle: "medium",
    });

    // Generate AI Instant Event Quotation (Agent #4)
    const quotation = generateEventQuotation({
      organization,
      location,
      crowdSizeStr: String(crowdSize),
      eventDate,
    });

    console.log("==================================================");
    console.log(`🚐 NEW VAN LOCATION REQUEST FOR: ${BUSINESS_EMAIL}`);
    console.log(`Contact: ${contact}`);
    console.log(`Organization/College: ${organization}`);
    console.log(`Target Location: ${location}`);
    console.log(`Preferred Date: ${eventDate}`);
    console.log(`Crowd Estimate: ${crowdSize}`);
    console.log(`AI Quote - Recommended Tier: ₹${quotation.tiers.find(t => t.isRecommended)?.totalAmount || quotation.tiers[0].totalAmount}`);
    console.log(`Notes: ${notes}`);
    console.log(`Received At: ${timestamp}`);
    console.log("==================================================");

    // Prepare email content
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
      <span class="value">${crowdSize}</span>
    </div>

    ${
      notes
        ? `<div class="notes-box"><strong>Additional Notes:</strong><br>${notes}</div>`
        : ""
    }

    <div class="footer">
      <p>Business Destination: <strong>${BUSINESS_EMAIL}</strong></p>
      <a href="mailto:${contact}?subject=Re: BREW Mobile Van Request at ${encodeURIComponent(organization)}" class="btn">Reply to Customer (${contact})</a>
    </div>
  </div>
</body>
</html>
`;

    // Check if SMTP is configured in environment variables
    const smtpHost = process.env.SMTP_HOST;
    const smtpPort = parseInt(process.env.SMTP_PORT || "587", 10);
    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;

    let emailSent = false;
    let emailError: string | null = null;

    if (smtpHost && smtpUser && smtpPass) {
      try {
        const transporter = nodemailer.createTransport({
          host: smtpHost,
          port: smtpPort,
          secure: smtpPort === 465,
          auth: {
            user: smtpUser,
            pass: smtpPass,
          },
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
        console.log(`✓ Email successfully sent via SMTP to ${BUSINESS_EMAIL}`);
      } catch (err) {
        console.error("SMTP transport error:", err);
        emailError = err instanceof Error ? err.message : "SMTP send failed";
      }
    } else {
      console.log(`ℹ️ SMTP not configured in .env.local — logged request locally for ${BUSINESS_EMAIL}`);
    }

    // Build direct Gmail Web compose URL & standard mailto URL
    const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(
      BUSINESS_EMAIL
    )}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(textContent)}`;

    const mailtoUrl = `mailto:${BUSINESS_EMAIL}?subject=${encodeURIComponent(
      subject
    )}&body=${encodeURIComponent(textContent)}`;

    // Persist to local JSON file
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
      existing.unshift({
        id: `req-${Date.now()}`,
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
      });
      fs.writeFileSync(filePath, JSON.stringify(existing, null, 2), "utf-8");
    } catch (fsErr) {
      console.error("Failed to write request to file:", fsErr);
    }

    return NextResponse.json({
      success: true,
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
    });
  } catch (error) {
    console.error("Van request handler failed:", error);
    return NextResponse.json(
      { error: "Internal server error processing van request" },
      { status: 500 }
    );
  }
}

export async function GET() {
  try {
    const filePath = path.join(process.cwd(), "src/data/van_requests.json");
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      return NextResponse.json(data);
    }
    return NextResponse.json([]);
  } catch (error) {
    console.error("Failed to read van requests:", error);
    return NextResponse.json([]);
  }
}
