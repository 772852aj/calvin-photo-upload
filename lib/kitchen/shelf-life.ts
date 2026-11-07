import type { Category, StorageLocation } from "./types";

// Quality-based storage guidelines, in months. Freezer numbers follow the
// USDA/FoodKeeper ranges (food kept at 0°F stays safe indefinitely; these are
// "best quality" windows). We use the conservative end of each range.
const FREEZER_MONTHS: Record<Category, number> = {
  beef: 6, // steaks/roasts 4–12
  pork: 4, // chops/roasts 4–6
  poultry: 9, // pieces 9, whole 12
  seafood: 3, // fatty fish 2–3, lean 6–8
  "ground meat": 3, // 3–4
  "processed meat": 1, // bacon/sausage/hot dogs 1–2
  "prepared meal": 3, // casseroles, soups, leftovers 2–3
  vegetables: 8, // 8–12
  fruit: 8,
  "bread & baked goods": 3,
  dairy: 3, // butter 6–9, cheese 4, ice cream 2
  dessert: 2,
  breakfast: 2, // waffles, breakfast sandwiches
  snack: 2,
  "canned goods": 12,
  "dry goods & grains": 6,
  baking: 6,
  "condiments & sauces": 3,
  spices: 12,
  beverages: 6,
  other: 3,
};

const PANTRY_MONTHS: Record<Category, number> = {
  beef: 0,
  pork: 0,
  poultry: 0,
  seafood: 0,
  "ground meat": 0,
  "processed meat": 0,
  "prepared meal": 0,
  vegetables: 0.5, // potatoes/onions
  fruit: 0.25,
  "bread & baked goods": 0.25,
  dairy: 0,
  dessert: 3,
  breakfast: 6, // cereal, oats
  snack: 3,
  "canned goods": 24,
  "dry goods & grains": 12,
  baking: 12,
  "condiments & sauces": 12,
  spices: 24,
  beverages: 9,
  other: 6,
};

const FRIDGE_DAYS: Record<Category, number> = {
  beef: 4,
  pork: 4,
  poultry: 2,
  seafood: 2,
  "ground meat": 2,
  "processed meat": 7,
  "prepared meal": 4,
  vegetables: 7,
  fruit: 7,
  "bread & baked goods": 7,
  dairy: 10,
  dessert: 5,
  breakfast: 7,
  snack: 14,
  "canned goods": 4, // once opened
  "dry goods & grains": 30,
  baking: 30,
  "condiments & sauces": 60,
  spices: 180,
  beverages: 10,
  other: 7,
};

export function guidelineDays(category: Category, location: StorageLocation): number {
  if (location === "freezer") return Math.round(FREEZER_MONTHS[category] * 30);
  if (location === "fridge") return FRIDGE_DAYS[category];
  const months = PANTRY_MONTHS[category];
  // Perishables that don't belong in the pantry still get a short window.
  return months > 0 ? Math.round(months * 30) : 2;
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysUntil(isoDate: string, now = new Date()): number {
  const target = new Date(isoDate + "T00:00:00");
  const today = new Date(now.toISOString().slice(0, 10) + "T00:00:00");
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

export type Freshness = "expired" | "use soon" | "ok" | "fresh";

export function freshness(useBy: string): Freshness {
  const d = daysUntil(useBy);
  if (d < 0) return "expired";
  if (d <= 14) return "use soon";
  if (d <= 45) return "ok";
  return "fresh";
}

export const MAINTENANCE_TIPS: { title: string; body: string; cadence: string }[] = [
  {
    title: "Snap a photo every time you unload groceries",
    body: "Before the bags go in, take one picture of the new items on the counter and upload it here. The review step merges duplicates into what you already have.",
    cadence: "Every shopping trip",
  },
  {
    title: "Tap \"Used 1\" when something comes out",
    body: "Keeping counts current is the only way the shopping list and meal ideas stay useful. If you forget, the monthly audit catches it.",
    cadence: "As you cook",
  },
  {
    title: "Monthly freezer audit (10 minutes)",
    body: "Open the freezer, take 2–3 wide photos, upload them as an audit, and mark anything missing as used up. Check the \"Use soon\" list and plan those into the week.",
    cadence: "Monthly",
  },
  {
    title: "First in, first out",
    body: "Move older packages to the front or top basket when new ones go in. The app's Use-by dates tell you which is older.",
    cadence: "Every restock",
  },
  {
    title: "Label anything you freeze yourself",
    body: "Write the contents and date on leftovers and repackaged meat with a marker. The photo reader picks up handwriting.",
    cadence: "Every time",
  },
  {
    title: "Keep the freezer at 0°F (-18°C) and about 3/4 full",
    body: "A full freezer holds temperature better; an overfull one blocks airflow. Put a cheap thermometer inside.",
    cadence: "Check quarterly",
  },
  {
    title: "Defrost and deep-clean a manual-defrost chest freezer",
    body: "When frost gets about 1/4 inch thick, empty it into coolers, defrost, wipe down with baking soda and water, and do a full photo re-inventory while everything's out.",
    cadence: "1–2× a year",
  },
  {
    title: "Pantry sweep",
    body: "Take one photo per shelf. Look for duplicates (three open bags of the same flour), stale snacks, and cans past their date.",
    cadence: "Quarterly",
  },
];
