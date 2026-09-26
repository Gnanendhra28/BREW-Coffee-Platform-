import { NextRequest, NextResponse } from "next/server";
import { generateBaristaResponse } from "@/lib/baristaEngine";
import { MENU_ITEMS } from "@/data/menuData";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { message, history = [] } = body;

    if (!message || typeof message !== "string") {
      return NextResponse.json(
        { error: "Message is required" },
        { status: 400 }
      );
    }

    const geminiApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENAI_API_KEY;

    // If Gemini API Key is available, attempt grounded generative response
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
            const parsed = JSON.parse(rawText);
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
              return NextResponse.json({
                replyText: parsed.replyText,
                recommendations: recommendedItems,
                quickReplies: parsed.quickReplies || [
                  "Suggest a dessert pairing",
                  "Something iced instead",
                  "Explore Full Menu",
                ],
              });
            }
          }
        }
      } catch (geminiErr) {
        console.warn("Gemini API call failed, falling back to local barista engine:", geminiErr);
      }
    }

    // Default fast local semantic engine
    const localResult = generateBaristaResponse(message, history);
    return NextResponse.json(localResult);
  } catch (error) {
    console.error("Barista chat route error:", error);
    return NextResponse.json(
      { error: "Failed to process barista recommendation" },
      { status: 500 }
    );
  }
}
