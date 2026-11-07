import { NextRequest, NextResponse } from "next/server";
import type Anthropic from "@anthropic-ai/sdk";
import { FALLBACK_BETA, MODEL, apiErrorMessage, checkPasscode, getClient } from "@/lib/kitchen/claude";
import { CATEGORIES, MAJOR_ALLERGENS, type ExtractedItem } from "@/lib/kitchen/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // photo + web research can take a while

const MAX_TURNS = 8;
const ALLOWED_MEDIA = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
type MediaType = (typeof ALLOWED_MEDIA)[number];

interface AnalyzeBody {
  imageBase64: string;
  mediaType: string;
  location: "freezer" | "pantry" | "fridge";
  knownItems?: string[]; // names already in inventory, to help match duplicates
  today?: string;
}

const sourceEnum = { type: "string", enum: ["label", "researched", "estimated", "unknown"] };
const nullableString = { type: ["string", "null"] };

const RECORD_TOOL: Anthropic.Beta.BetaTool = {
  name: "record_items",
  description:
    "Record every distinct food product identified in the photo. Call this exactly once, after any research, as your final action.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["photo_summary", "items"],
    properties: {
      photo_summary: {
        type: "string",
        description: "One or two sentences describing what the photo shows overall.",
      },
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "name",
            "brand",
            "category",
            "quantity",
            "package_size",
            "net_weight_oz",
            "ingredients",
            "allergens",
            "may_contain",
            "dietary_flags",
            "printed_date",
            "printed_date_type",
            "description",
            "sources",
            "confidence",
            "notes",
            "research_urls",
          ],
          properties: {
            name: {
              type: "string",
              description:
                "Specific product name as a shopper would say it, e.g. 'Boneless Skinless Chicken Breasts' or 'Eggo Homestyle Waffles'. Not generic like 'meat'.",
            },
            brand: nullableString,
            category: { type: "string", enum: [...CATEGORIES] },
            quantity: {
              type: "integer",
              description: "How many separate packages of this exact product are visible.",
            },
            package_size: {
              ...nullableString,
              description: "Size per package as printed, e.g. '16 oz', '2.5 lb', '10 ct', '1.5 qt'.",
            },
            net_weight_oz: {
              type: ["number", "null"],
              description: "Package net weight converted to ounces, when it is a weight.",
            },
            ingredients: { type: "array", items: { type: "string" } },
            allergens: {
              type: "array",
              items: { type: "string", enum: [...MAJOR_ALLERGENS] },
              description: "Major allergens the product CONTAINS.",
            },
            may_contain: {
              type: "array",
              items: { type: "string", enum: [...MAJOR_ALLERGENS] },
              description: "Allergens from 'may contain' or shared-facility statements.",
            },
            dietary_flags: { type: "array", items: { type: "string" } },
            printed_date: {
              ...nullableString,
              description: "A date printed on the package, as YYYY-MM-DD. Null if none is legible.",
            },
            printed_date_type: {
              type: ["string", "null"],
              enum: ["best_by", "use_by", "sell_by", "packed_on", "unknown", null],
            },
            description: { type: "string" },
            sources: {
              type: "object",
              additionalProperties: false,
              required: ["name", "ingredients", "allergens", "size"],
              properties: {
                name: sourceEnum,
                ingredients: sourceEnum,
                allergens: sourceEnum,
                size: sourceEnum,
              },
            },
            confidence: {
              type: "number",
              description: "0 to 1: how sure you are this identification is right.",
            },
            notes: {
              ...nullableString,
              description: "Anything a human reviewer should double-check.",
            },
            research_urls: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  },
};

function systemPrompt(location: string, today: string, knownItems: string[]): string {
  return `You catalogue a family's food storage from photos. Today is ${today}. This photo is from their ${location}.

Your job for each photo:
1. Identify every distinct food product you can see. Read package labels closely: product name, brand, net weight/size, count, and any printed date (best by, use by, sell by, packed on). Count how many of each identical package are visible. Handwritten labels on freezer bags count too.
2. For branded products, use web search to look up the official ingredient list and allergen statement when the label in the photo doesn't show them legibly. Prefer the manufacturer's site, then major retailers. For unbranded or home-packed items (e.g. a bag of ground beef, leftovers), infer ingredients and allergens from what the food is, and mark those fields "estimated".
3. Mark where each field came from: "label" if you read it in the photo, "researched" if you found it on the web, "estimated" if you inferred it, "unknown" if you couldn't determine it.
4. Allergens: use only the FDA major allergens list. Be careful: wheat in breading, milk in sauces, eggs in waffles, soy in processed meats. If unsure whether something contains an allergen, include it and say so in notes. A missed allergen is worse than an extra one.
5. Be honest about uncertainty. A frosted bag you can't read should get low confidence and a note, not a guessed brand.

Items already in this household's inventory (use the same name when you see the same product, so duplicates can be merged): ${
    knownItems.length ? knownItems.slice(0, 200).join("; ") : "none yet"
  }.

Keep research focused: at most a few searches per photo, only for branded items whose ingredients or allergens aren't legible. When done, call record_items exactly once with everything you found. If the photo has no food in it, call record_items with an empty items list and say what the photo shows.`;
}

interface RecordInput {
  photo_summary: string;
  items: ExtractedItem[];
}

function isRecordInput(x: unknown): x is RecordInput {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  return typeof r.photo_summary === "string" && Array.isArray(r.items);
}

export async function POST(req: NextRequest) {
  const denied = checkPasscode(req);
  if (denied) return NextResponse.json({ error: denied }, { status: 401 });

  let body: AnalyzeBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { imageBase64, mediaType, location } = body;
  if (!imageBase64 || !mediaType || !location) {
    return NextResponse.json(
      { error: "imageBase64, mediaType and location are required" },
      { status: 400 },
    );
  }
  if (!ALLOWED_MEDIA.includes(mediaType as MediaType)) {
    return NextResponse.json({ error: `Unsupported image type ${mediaType}` }, { status: 400 });
  }

  const today = body.today || new Date().toISOString().slice(0, 10);
  const client = getClient();

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: mediaType as MediaType, data: imageBase64 },
        },
        { type: "text", text: "Catalogue everything in this photo." },
      ],
    },
  ];

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await client.beta.messages
        .stream({
          model: MODEL,
          max_tokens: 32000,
          betas: [FALLBACK_BETA],
          fallbacks: "default",
          thinking: { type: "adaptive" },
          output_config: { effort: "high" },
          system: systemPrompt(location, today, body.knownItems ?? []),
          tools: [
            { type: "web_search_20260209", name: "web_search", max_uses: 6 },
            RECORD_TOOL,
          ],
          messages,
        })
        .finalMessage();

      if (response.stop_reason === "refusal") {
        return NextResponse.json(
          { error: "The model declined to analyze this photo." },
          { status: 422 },
        );
      }

      const record = response.content.find(
        (b): b is Anthropic.Beta.BetaToolUseBlock =>
          b.type === "tool_use" && b.name === "record_items",
      );
      if (record) {
        if (!isRecordInput(record.input)) {
          return NextResponse.json({ error: "Model returned malformed items" }, { status: 502 });
        }
        return NextResponse.json({
          summary: record.input.photo_summary,
          items: record.input.items,
        });
      }

      messages.push({ role: "assistant", content: response.content });

      if (response.stop_reason === "pause_turn") continue; // server-side search still running

      if (response.stop_reason === "max_tokens") {
        return NextResponse.json(
          { error: "Analysis ran too long for this photo. Try a closer shot with fewer items." },
          { status: 502 },
        );
      }

      // Ended without recording: nudge it to finish.
      messages.push({
        role: "user",
        content: "Please call record_items now with everything you identified.",
      });
    }
    return NextResponse.json(
      { error: "Analysis did not finish. Try again or use a clearer photo." },
      { status: 502 },
    );
  } catch (err) {
    console.error("analyze error", err);
    const { status, message } = apiErrorMessage(err);
    return NextResponse.json({ error: message }, { status });
  }
}
