"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { addDays, guidelineDays } from "@/lib/kitchen/shelf-life";
import type {
  ExtractedItem,
  InventoryItem,
  KitchenState,
  ReviewCandidate,
  ShoppingEntry,
  StorageLocation,
} from "@/lib/kitchen/types";

const STORAGE_KEY = "kitchen-inventory-v1";

export const emptyState = (): KitchenState => ({
  version: 1,
  householdMember: "",
  photos: [],
  review: [],
  inventory: [],
  shopping: [],
  activity: [],
  avoidAllergens: [],
  lastAuditAt: { freezer: null, pantry: null, fridge: null },
});

export const uid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export const today = () => new Date().toISOString().slice(0, 10);

function normalize(s: string | null | undefined): string {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\b(the|a|an|of|and|with)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Find an inventory row that is probably the same product (for merge suggestions). */
export function findDuplicate(
  inventory: InventoryItem[],
  item: ExtractedItem,
  location: StorageLocation,
): InventoryItem | undefined {
  const n = normalize(item.name);
  const b = normalize(item.brand);
  return inventory.find((inv) => {
    if (inv.location !== location) return false;
    const sameName = normalize(inv.name) === n;
    const ib = normalize(inv.brand);
    const brandOk = !b || !ib || b === ib;
    const sizeOk =
      !item.package_size || !inv.package_size ||
      normalize(item.package_size) === normalize(inv.package_size);
    return sameName && brandOk && sizeOk;
  });
}

/** The date we plan around: printed date when we have one, otherwise a storage guideline. */
export function computeUseBy(
  item: ExtractedItem,
  location: StorageLocation,
  addedAt: string,
): { useBy: string; useBySource: "printed" | "guideline" } {
  const days = guidelineDays(item.category, location);
  if (item.printed_date && /^\d{4}-\d{2}-\d{2}$/.test(item.printed_date)) {
    if (item.printed_date_type === "packed_on") {
      return { useBy: addDays(item.printed_date, days), useBySource: "printed" };
    }
    // Freezing pauses the clock: a best-by on a frozen item is a quality date,
    // so take whichever is later of the printed date and the freezer guideline.
    if (location === "freezer") {
      const guideline = addDays(addedAt, days);
      return {
        useBy: item.printed_date > guideline ? item.printed_date : guideline,
        useBySource: item.printed_date > guideline ? "printed" : "guideline",
      };
    }
    return { useBy: item.printed_date, useBySource: "printed" };
  }
  return { useBy: addDays(addedAt, days), useBySource: "guideline" };
}

export function useKitchenStore() {
  const [state, setState] = useState<KitchenState>(emptyState);
  const [loaded, setLoaded] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const first = useRef(true);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as KitchenState;
        if (parsed?.version === 1) setState({ ...emptyState(), ...parsed });
      }
    } catch {
      // storage unavailable (private mode); run in memory
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    if (first.current) {
      first.current = false;
      return;
    }
    try {
      // Photos stuck mid-analysis can't resume after reload; persist them as errors.
      const toSave: KitchenState = {
        ...state,
        photos: state.photos.map((p) =>
          p.status === "analyzing" || p.status === "queued"
            ? { ...p, status: "error", error: "Interrupted. Re-upload this photo." }
            : p,
        ),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
      setSaveError(null);
    } catch {
      setSaveError(
        "This browser's storage is full. Export a backup in Upkeep, then clear old photos.",
      );
    }
  }, [state, loaded]);

  const update = useCallback((fn: (s: KitchenState) => KitchenState) => setState(fn), []);

  const log = useCallback(
    (s: KitchenState, action: string): KitchenState => ({
      ...s,
      activity: [
        { at: new Date().toISOString(), who: s.householdMember || "someone", action },
        ...s.activity,
      ].slice(0, 300),
    }),
    [],
  );

  const approve = useCallback(
    (candidateId: string, edited: ExtractedItem, merge: boolean) => {
      setState((s) => {
        const cand = s.review.find((r) => r.id === candidateId);
        if (!cand) return s;
        const now = new Date().toISOString();
        const addedAt = today();
        let inventory = s.inventory;
        let action: string;
        const dup = merge && cand.matchInventoryId
          ? s.inventory.find((i) => i.id === cand.matchInventoryId)
          : undefined;
        if (dup) {
          const { useBy } = computeUseBy(edited, cand.location, addedAt);
          inventory = s.inventory.map((i) =>
            i.id === dup.id
              ? {
                  ...i,
                  quantity: i.quantity + edited.quantity,
                  // Keep the earliest date so the oldest package gets used first.
                  useBy: useBy < i.useBy ? useBy : i.useBy,
                  allergens: Array.from(new Set([...i.allergens, ...edited.allergens])),
                  may_contain: Array.from(new Set([...i.may_contain, ...edited.may_contain])),
                  photoIds: Array.from(new Set([...i.photoIds, cand.photoId])),
                  updatedAt: now,
                }
              : i,
          );
          action = `added ${edited.quantity} × ${edited.name} to existing stock`;
        } else {
          const { useBy, useBySource } = computeUseBy(edited, cand.location, addedAt);
          const row: InventoryItem = {
            ...edited,
            id: uid(),
            location: cand.location,
            addedAt,
            updatedAt: now,
            useBy,
            useBySource,
            photoIds: [cand.photoId],
            reviewedBy: s.householdMember || "someone",
            lowStockAt: 0,
            shelf: null,
          };
          inventory = [...s.inventory, row];
          action = `added ${edited.quantity} × ${edited.name} to ${cand.location}`;
        }
        const shopping = s.shopping.filter(
          (e) => e.done || normalize(e.name) !== normalize(edited.name),
        );
        return log(
          {
            ...s,
            inventory,
            shopping,
            review: s.review.map((r) =>
              r.id === candidateId ? { ...r, item: edited, status: "approved" } : r,
            ),
          },
          action,
        );
      });
    },
    [log],
  );

  const reject = useCallback(
    (candidateId: string) =>
      setState((s) => ({
        ...s,
        review: s.review.map((r) => (r.id === candidateId ? { ...r, status: "rejected" } : r)),
      })),
    [],
  );

  const changeQty = useCallback(
    (id: string, delta: number) =>
      setState((s) => {
        const item = s.inventory.find((i) => i.id === id);
        if (!item) return s;
        const quantity = Math.max(0, item.quantity + delta);
        let shopping = s.shopping;
        const alreadyListed = s.shopping.some(
          (e) => !e.done && normalize(e.name) === normalize(item.name),
        );
        if (quantity <= item.lowStockAt && delta < 0 && !alreadyListed) {
          const entry: ShoppingEntry = {
            id: uid(),
            name: item.brand ? `${item.name} (${item.brand})` : item.name,
            location: item.location,
            reason: quantity === 0 ? "used up" : "low stock",
            done: false,
          };
          shopping = [...s.shopping, entry];
        }
        return log(
          {
            ...s,
            shopping,
            inventory: s.inventory.map((i) =>
              i.id === id ? { ...i, quantity, updatedAt: new Date().toISOString() } : i,
            ),
          },
          delta < 0 ? `used 1 × ${item.name}` : `added 1 × ${item.name}`,
        );
      }),
    [log],
  );

  const editItem = useCallback(
    (id: string, patch: Partial<InventoryItem>) =>
      setState((s) => ({
        ...s,
        inventory: s.inventory.map((i) =>
          i.id === id ? { ...i, ...patch, updatedAt: new Date().toISOString() } : i,
        ),
      })),
    [],
  );

  const removeItem = useCallback(
    (id: string) =>
      setState((s) => {
        const item = s.inventory.find((i) => i.id === id);
        return log(
          { ...s, inventory: s.inventory.filter((i) => i.id !== id) },
          `removed ${item?.name ?? "an item"}`,
        );
      }),
    [log],
  );

  return { state, loaded, saveError, update, log, approve, reject, changeQty, editItem, removeItem };
}

export type KitchenStore = ReturnType<typeof useKitchenStore>;

export function addCandidates(
  s: KitchenState,
  photoId: string,
  location: StorageLocation,
  items: ExtractedItem[],
): KitchenState {
  const fresh: ReviewCandidate[] = items.map((item) => ({
    id: uid(),
    photoId,
    location,
    item,
    status: "needs_review",
    matchInventoryId: findDuplicate(s.inventory, item, location)?.id,
  }));
  return { ...s, review: [...s.review, ...fresh] };
}

/** Downscale a photo in the browser before sending it (faster, cheaper, under upload limits). */
export async function prepareImage(
  file: File,
): Promise<{ base64: string; mediaType: "image/jpeg"; thumb: string }> {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error(
      "This browser can't read that image format. On iPhone, set Camera → Formats → Most Compatible, or share as JPEG.",
    );
  });
  const draw = (maxEdge: number, quality: number) => {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas not available");
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", quality);
  };
  const full = draw(1568, 0.85); // Claude's recommended long-edge limit
  const thumb = draw(180, 0.6);
  bitmap.close();
  return { base64: full.split(",")[1], mediaType: "image/jpeg", thumb };
}

export function toCsv(items: InventoryItem[]): string {
  const cols: (keyof InventoryItem)[] = [
    "location",
    "name",
    "brand",
    "category",
    "quantity",
    "package_size",
    "net_weight_oz",
    "useBy",
    "useBySource",
    "printed_date",
    "allergens",
    "may_contain",
    "ingredients",
    "confidence",
    "addedAt",
    "reviewedBy",
    "shelf",
  ];
  const esc = (v: unknown) => {
    const s = Array.isArray(v) ? v.join("; ") : v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...items.map((i) => cols.map((c) => esc(i[c])).join(","))].join("\n");
}
