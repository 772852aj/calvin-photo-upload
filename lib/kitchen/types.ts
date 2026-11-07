// Shared data model for the Kitchen Inventory app.
// Every item keeps lineage back to the photo it came from and to who
// reviewed it, so you can always answer "where did this record come from?"

export type StorageLocation = "freezer" | "pantry" | "fridge";

export const LOCATIONS: { id: StorageLocation; label: string; emoji: string }[] = [
  { id: "freezer", label: "Deep Freezer", emoji: "🧊" },
  { id: "pantry", label: "Pantry", emoji: "🥫" },
  { id: "fridge", label: "Fridge", emoji: "🥛" },
];

export const CATEGORIES = [
  "beef",
  "pork",
  "poultry",
  "seafood",
  "ground meat",
  "processed meat",
  "prepared meal",
  "vegetables",
  "fruit",
  "bread & baked goods",
  "dairy",
  "dessert",
  "breakfast",
  "snack",
  "canned goods",
  "dry goods & grains",
  "baking",
  "condiments & sauces",
  "spices",
  "beverages",
  "other",
] as const;
export type Category = (typeof CATEGORIES)[number];

// FDA "major food allergens" (the Big 9).
export const MAJOR_ALLERGENS = [
  "milk",
  "eggs",
  "fish",
  "shellfish",
  "tree nuts",
  "peanuts",
  "wheat",
  "soy",
  "sesame",
] as const;
export type Allergen = (typeof MAJOR_ALLERGENS)[number];

// Where a field's value came from. Lets the review screen show how much to trust it.
export type FieldSource = "label" | "researched" | "estimated" | "unknown";

export interface ExtractedItem {
  name: string;
  brand: string | null;
  category: Category;
  quantity: number;
  package_size: string | null; // e.g. "16 oz", "2 lb", "12 count"
  net_weight_oz: number | null; // normalised to ounces when possible
  ingredients: string[];
  allergens: Allergen[]; // contains
  may_contain: Allergen[]; // "may contain" / shared-facility warnings
  dietary_flags: string[]; // e.g. "gluten-free", "vegan", "high sodium"
  printed_date: string | null; // YYYY-MM-DD if a date is visible on the package
  printed_date_type: "best_by" | "use_by" | "sell_by" | "packed_on" | "unknown" | null;
  description: string; // one-line what-this-is
  sources: {
    name: FieldSource;
    ingredients: FieldSource;
    allergens: FieldSource;
    size: FieldSource;
  };
  confidence: number; // 0..1, model's confidence in the identification
  notes: string | null; // anything the reviewer should double-check
  research_urls: string[];
}

export type ReviewStatus = "needs_review" | "approved" | "rejected";

export interface PhotoRecord {
  id: string;
  fileName: string;
  thumb: string; // small JPEG data URL kept for lineage
  location: StorageLocation;
  uploadedAt: string;
  status: "queued" | "analyzing" | "done" | "error";
  error?: string;
  summary?: string; // model's description of the whole photo
}

export interface ReviewCandidate {
  id: string;
  photoId: string;
  location: StorageLocation;
  item: ExtractedItem;
  status: ReviewStatus;
  matchInventoryId?: string; // possible duplicate already in inventory
}

export interface InventoryItem extends ExtractedItem {
  id: string;
  location: StorageLocation;
  addedAt: string; // when it went into the freezer/pantry
  updatedAt: string;
  useBy: string; // the date we plan around (printed date or shelf-life estimate)
  useBySource: "printed" | "guideline";
  photoIds: string[];
  reviewedBy: string;
  lowStockAt: number; // add to shopping list at or below this quantity
  shelf: string | null; // optional bin/shelf ("top basket", "left door")
}

export interface ActivityEntry {
  at: string;
  who: string;
  action: string;
}

export interface ShoppingEntry {
  id: string;
  name: string;
  location: StorageLocation;
  reason: "low stock" | "used up" | "manual" | "recipe";
  done: boolean;
}

export interface KitchenState {
  version: 1;
  householdMember: string;
  photos: PhotoRecord[];
  review: ReviewCandidate[];
  inventory: InventoryItem[];
  shopping: ShoppingEntry[];
  activity: ActivityEntry[];
  avoidAllergens: Allergen[];
  lastAuditAt: Record<StorageLocation, string | null>;
}

export type MealType = "breakfast" | "lunch" | "dinner" | "dessert" | "snack";

export interface MealIdea {
  title: string;
  meal_type: MealType;
  summary: string;
  uses_inventory: string[]; // names of items we already have
  needs_to_buy: string[];
  allergens: Allergen[];
  steps: string[];
  prep_minutes: number;
  uses_expiring_soon: boolean;
}
