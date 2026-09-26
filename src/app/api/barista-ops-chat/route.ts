import { NextRequest, NextResponse } from "next/server";
import {
  processEmployeeOpsQuery,
  CURATED_PARKING_SPOTS,
} from "@/lib/employeeBaristaOpsEngine";
import { checkRateLimit, getClientIp } from "@/lib/rateLimit";
import { getCachedAgentData, setCachedAgentData } from "@/lib/agentCache";
import {
  BaristaOpsChatResponseSchema,
  safeValidateAgentOutput,
} from "@/lib/agentSchemas";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    // 1. IP-Based Rate Limiting (Max 15 queries / 60s per employee IP)
    const clientIp = getClientIp(req);
    const rateLimit = await checkRateLimit(clientIp, "barista-ops-chat", 15, 60);

    const rateLimitHeaders = {
      "X-RateLimit-Limit": rateLimit.limit.toString(),
      "X-RateLimit-Remaining": rateLimit.remaining.toString(),
      "X-RateLimit-Reset": rateLimit.reset.toString(),
    };

    if (!rateLimit.success) {
      return NextResponse.json(
        {
          error: "Too Many Requests to AI Ops Copilot. Please wait a moment.",
          retryAfterSeconds: Math.max(1, rateLimit.reset - Math.floor(Date.now() / 1000)),
        },
        {
          status: 429,
          headers: {
            ...rateLimitHeaders,
            "Retry-After": Math.max(1, rateLimit.reset - Math.floor(Date.now() / 1000)).toString(),
          },
        }
      );
    }

    const body = await req.json();
    const {
      message,
      activeVanLocation,
      futureStops = [],
      reviews = [],
      history = [],
    } = body;

    if (!message || typeof message !== "string") {
      return NextResponse.json(
        { error: "Message is required" },
        { status: 400, headers: rateLimitHeaders }
      );
    }

    const normalizedQuery = message.trim().toLowerCase();
    const cacheKey = `barista_ops:${normalizedQuery}`;

    // 2. 30-Minute Fallback Cache Check (Parking bays & weather recommendations)
    const cachedResponse = await getCachedAgentData<Record<string, unknown>>(cacheKey);
    if (cachedResponse) {
      return NextResponse.json(
        {
          ...cachedResponse,
          cached: true,
        },
        { headers: rateLimitHeaders }
      );
    }

    const geminiApiKey =
      process.env.GEMINI_API_KEY || process.env.GOOGLE_GENAI_API_KEY;

    if (geminiApiKey) {
      try {
        const systemPrompt = `You are the AI Fleet Dispatcher & Operations Copilot for "BREW", a luxury mobile coffee van company in Telangana and Andhra Pradesh.
You assist employees and baristas with:
1. Optimal van parking locations based on date, weather, customer reviews, and landmarks.
2. Checking fleet proximity to avoid clustering with other vans.
3. Reviewing customer complaints/praise to generate staff improvement plans.

Fleet Hubs Database:
${JSON.stringify(CURATED_PARKING_SPOTS.slice(0, 5))}

Active Van Station: ${JSON.stringify(activeVanLocation || {})}
Recent Customer Reviews: ${JSON.stringify(reviews.slice(0, 5))}

Provide a direct, helpful, professional barista ops response in clean formatting.`;

        const promptPayload = {
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: `${systemPrompt}\n\nEmployee Chat History: ${JSON.stringify(
                    history.slice(-4)
                  )}\n\nBarista asked: "${message}"`,
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.3,
          },
        };

        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiApiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(promptPayload),
            signal: AbortSignal.timeout(6000),
          }
        );

        if (res.ok) {
          const data = await res.json();
          const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (rawText) {
            const localFallback = processEmployeeOpsQuery(message, {
              activeVanLocation,
              futureStops,
              reviews,
            });

            const candidateResponse = {
              replyText: rawText,
              recommendedSpots: localFallback.recommendedSpots || [],
              improvementPlan: localFallback.improvementPlan || null,
              quickReplies: localFallback.quickReplies || [],
            };

            // Zod Guardrail Validation
            const validated = safeValidateAgentOutput(
              BaristaOpsChatResponseSchema,
              candidateResponse
            );

            if (validated.success) {
              // Cache parking and ops recommendations for 30 minutes (1800s)
              await setCachedAgentData(cacheKey, validated.data, 1800);

              return NextResponse.json(validated.data, { headers: rateLimitHeaders });
            }
          }
        }
      } catch (geminiErr) {
        console.warn("Gemini Ops API call failed, falling back to local engine:", geminiErr);
      }
    }

    // Default fast local ops engine
    const localResult = processEmployeeOpsQuery(message, {
      activeVanLocation,
      futureStops,
      reviews,
    });

    const validatedLocal = safeValidateAgentOutput(
      BaristaOpsChatResponseSchema,
      localResult
    );

    const finalResult = validatedLocal.success ? validatedLocal.data : localResult;

    // Cache local result for 30 minutes
    await setCachedAgentData(cacheKey, finalResult, 1800);

    return NextResponse.json(finalResult, { headers: rateLimitHeaders });
  } catch (error) {
    console.error("Barista ops chat error:", error);
    return NextResponse.json(
      { error: "Failed to process ops assistant query" },
      { status: 500 }
    );
  }
}
