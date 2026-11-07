import { NextRequest, NextResponse } from "next/server";
import { FALLBACK_BETA, MODEL, apiErrorMessage, checkPasscode, getClient } from "@/lib/kitchen/claude";
import { MAJOR_ALLERGENS, type MealIdea, type MealType } from "@/lib/kitchen/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

interface MealsBody {
  mealType: MealType;
  avoidAllergens: string[];
  servings?: number;
  extraRequest?: string;
  items: {
    name: string;
    location: string;
    quantity: number;
    package_size: string | null;
    useBy: string;
    allergens: string[];
  }[];
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ideas"],
  properties: {
    ideas: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "title",
          "meal_type",
          "summary",
          "uses_inventory",
          "needs_to_buy",
          "allergens",
          "steps",
          "prep_minutes",
          "uses_expiring_soon",
        ],
        properties: {
          title: { type: "string" },
          meal_type: { type: "string", enum: ["breakfast", "lunch", "dinner", "dessert", "snack"] },
          summary: { type: "string" },
          uses_inventory: { type: "array", items: { type: "string" } },
          needs_to_buy: { type: "array", items: { type: "string" } },
          allergens: { type: "array", items: { type: "string", enum: [...MAJOR_ALLERGENS] } },
          steps: { type: "array", items: { type: "string" } },
          prep_minutes: { type: "integer" },
          uses_expiring_soon: { type: "boolean" },
        },
      },
    },
  },
} as const;

export async function POST(req: NextRequest) {
  const denied = checkPasscode(req);
  if (denied) return NextResponse.json({ error: denied }, { status: 401 });

  let body: MealsBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.mealType || !Array.isArray(body.items)) {
    return NextResponse.json({ error: "mealType and items are required" }, { status: 400 });
  }
  if (body.items.length === 0) {
    return NextResponse.json({ error: "Inventory is empty. Add some items first." }, { status: 400 });
  }

  const today = new Date().toISOString().slice(0, 10);
  const inventory = body.items
    .slice(0, 400)
    .map(
      (i) =>
        `- ${i.name} (${i.location}, qty ${i.quantity}${i.package_size ? `, ${i.package_size}` : ""}, use by ${i.useBy}${
          i.allergens.length ? `, contains ${i.allergens.join("/")}` : ""
        })`,
    )
    .join("\n");

  const avoid = body.avoidAllergens.length ? body.avoidAllergens.join(", ") : "none";

  const prompt = `Today is ${today}. Here is what this household has on hand:
${inventory}

Suggest 4 ${body.mealType} ideas for ${body.servings ?? 4} people.
- Build mainly from what they have. Keep the "needs to buy" list short, and assume basic staples (salt, pepper, oil) are on hand.
- Favor items whose use-by date is within the next 3 weeks, and set uses_expiring_soon when an idea does.
- The household avoids these allergens: ${avoid}. No idea may contain them, including in ingredients they need to buy.
- List every major allergen each idea contains.
- If anything comes from the freezer, include the thaw step and time in the steps.
${body.extraRequest ? `- Extra request from the family: ${body.extraRequest}` : ""}`;

  try {
    const client = getClient();
    const response = await client.beta.messages
      .stream({
        model: MODEL,
        max_tokens: 16000,
        betas: [FALLBACK_BETA],
        fallbacks: "default",
        output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
        messages: [{ role: "user", content: prompt }],
      })
      .finalMessage();

    if (response.stop_reason === "refusal") {
      return NextResponse.json({ error: "The model declined this request." }, { status: 422 });
    }
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    const parsed = JSON.parse(text) as { ideas: MealIdea[] };
    return NextResponse.json(parsed);
  } catch (err) {
    console.error("meals error", err);
    const { status, message } = apiErrorMessage(err);
    return NextResponse.json({ error: message }, { status });
  }
}
