import { NextRequest, NextResponse } from "next/server";
import { generateBaristaResponse } from "@/lib/baristaEngine";
import { MENU_ITEMS } from "@/data/menuData";
import { checkRateLimit, getClientIp } from "@/lib/rateLimit";
import { getCachedAgentData, setCachedAgentData } from "@/lib/agentCache";
import {
  BaristaChatResponseSchema,
  safeValidateAgentOutput,
} from "@/lib/agentSchemas";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    // 1. IP-Based Sliding Window Rate Limiting (Max 10 requests / 60 seconds per IP)
    const clientIp = getClientIp(req);
    const rateLimit = await checkRateLimit(clientIp, "barista-chat", 10, 60);

    const rateLimitHeaders = {
      "X-RateLimit-Limit": rateLimit.limit.toString(),
      "X-RateLimit-Remaining": rateLimit.remaining.toString(),
      "X-RateLimit-Reset": rateLimit.reset.toString(),
    };

    if (!rateLimit.success) {
      return NextResponse.json(
        {
          error: "Too Many Requests. AI Barista is crafting too many recommendations. Please wait a moment.",
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
    const { message, history = [] } = body;

    if (!message || typeof message !== "string") {
      return NextResponse.json(
        { error: "Message is required" },
        { status: 400, headers: rateLimitHeaders }
      );
    }

    const normalizedQuery = message.trim().toLowerCase();
    const cacheKey = `barista_chat:${normalizedQuery}`;

    // 2. 30-Minute Fallback Cache Check (Deduplicates repeated queries)
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

    const geminiApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENAI_API_KEY;

    // 3. Grounded Gemini 1.5 Flash Call with Zod Guardrail Validation
    if (geminiApiKey) {
      try {
        const catalogContext = MENU_ITEMS.map((m) => ({
          id: m.id,
          name: m.name,
          category: m.category,
          price: m.price,
          description: m.description,
          notes: m.notes,
        }));

        const systemPrompt = `You are the master barista at "BREW", a luxury artisanal mobile coffee van.
Customers will describe their taste preferences, cravings, mood, or past orders.
Your goal is to warmly understand their taste and recommend 1 to 2 items strictly from the BREW menu catalog provided below.

BREW Menu Catalog:
${JSON.stringify(catalogContext)}

Respond in valid JSON with this exact structure:
{
  "replyText": "Warm, engaging barista message explaining the choice in 2-3 sentences.",
  "recommendedItemIds": ["id-1", "id-2"],
  "reasons": ["Specific reason item 1 matches their taste", "Specific reason item 2 matches"],
  "quickReplies": ["Quick suggestion 1", "Quick suggestion 2"]
}`;

        const promptPayload = {
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: `${systemPrompt}\n\nCustomer Chat History: ${JSON.stringify(
                    history.slice(-4)
                  )}\n\nCustomer said: "${message}"`,
                },
              ],
            },
          ],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.4,
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
            const rawParsed = JSON.parse(rawText);

            // Zod Guardrail Schema Validation
            const validated = safeValidateAgentOutput(BaristaChatResponseSchema, rawParsed);
            if (validated.success) {
              const parsed = validated.data;
              const recommendedItems = (parsed.recommendedItemIds || [])
                .map((id: string, idx: number) => {
                  const found = MENU_ITEMS.find((m) => m.id === id);
                  if (!found) return null;
                  return {
                    item: found,
                    reason: parsed.reasons?.[idx] || "Special barista pick for your palate",
                  };
                })
                .filter(Boolean);

              if (recommendedItems.length > 0) {
                const responseData = {
                  replyText: parsed.replyText,
                  recommendations: recommendedItems,
                  quickReplies: parsed.quickReplies || [
                    "Suggest a dessert pairing",
                    "Something iced instead",
                    "Explore Full Menu",
                  ],
                };

                // Store in cache with 30-minute (1800s) TTL
                await setCachedAgentData(cacheKey, responseData, 1800);

                return NextResponse.json(responseData, { headers: rateLimitHeaders });
              }
            } else {
              console.warn(
                "[Barista Agent Guardrail Violation] Malformed Gemini output, falling back:",
                validated.error
              );
            }
          }
        }
      } catch (geminiErr) {
        console.warn("Gemini API call failed, falling back to local barista engine:", geminiErr);
      }
    }

    // 4. Default fast local semantic engine fallback
    const localResult = generateBaristaResponse(message, history);

    // Cache local response as well for efficiency
    await setCachedAgentData(cacheKey, localResult, 1800);

    return NextResponse.json(localResult, { headers: rateLimitHeaders });
  } catch (error) {
    console.error("Barista chat route error:", error);
    return NextResponse.json(
      { error: "Failed to process barista recommendation" },
      { status: 500 }
    );
  }
}
