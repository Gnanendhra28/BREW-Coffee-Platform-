import { NextRequest, NextResponse } from "next/server";
import {
  processEmployeeOpsQuery,
  CURATED_PARKING_SPOTS,
} from "@/lib/employeeBaristaOpsEngine";

export async function POST(req: NextRequest) {
  try {
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
        { status: 400 }
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
            // Also fetch structured spots or improvement plans for rich cards
            const localFallback = processEmployeeOpsQuery(message, {
              activeVanLocation,
              futureStops,
              reviews,
            });

            return NextResponse.json({
              replyText: rawText,
              recommendedSpots: localFallback.recommendedSpots,
              improvementPlan: localFallback.improvementPlan,
              quickReplies: localFallback.quickReplies,
            });
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

    return NextResponse.json(localResult);
  } catch (error) {
    console.error("Barista ops chat route error:", error);
    return NextResponse.json(
      { error: "Failed to process barista operations query" },
      { status: 500 }
    );
  }
}
