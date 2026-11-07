"use client";

import { useMemo, useRef, useState } from "react";
import {
  addCandidates,
  prepareImage,
  today,
  toCsv,
  uid,
  useKitchenStore,
  type KitchenStore,
} from "./store";
import { MAINTENANCE_TIPS, daysUntil, freshness } from "@/lib/kitchen/shelf-life";
import {
  CATEGORIES,
  LOCATIONS,
  MAJOR_ALLERGENS,
  type Allergen,
  type Category,
  type ExtractedItem,
  type FieldSource,
  type InventoryItem,
  type KitchenState,
  type MealIdea,
  type MealType,
  type PhotoRecord,
  type ReviewCandidate,
  type StorageLocation,
} from "@/lib/kitchen/types";

type Tab = "scan" | "review" | "inventory" | "meals" | "shopping" | "upkeep";
const CONCURRENCY = 2;

function getPasscode(): string {
  try {
    return localStorage.getItem("kitchen-passcode") || "";
  } catch {
    return "";
  }
}

async function api<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-kitchen-passcode": getPasscode() },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: `Server error ${res.status}` }));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data as T;
}

const locLabel = (l: StorageLocation) => LOCATIONS.find((x) => x.id === l)!;

export default function KitchenPage() {
  const store = useKitchenStore();
  const { state } = store;
  const [tab, setTab] = useState<Tab>("scan");

  const pendingReview = state.review.filter((r) => r.status === "needs_review").length;
  const shoppingOpen = state.shopping.filter((s) => !s.done).length;

  if (!store.loaded) return <main className="kitchen"><div className="k-wrap">Loading…</div></main>;

  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: "scan", label: "📸 Scan" },
    { id: "review", label: "✅ Review", badge: pendingReview },
    { id: "inventory", label: "🧊 Inventory" },
    { id: "meals", label: "🍳 Meals" },
    { id: "shopping", label: "🛒 Shopping", badge: shoppingOpen },
    { id: "upkeep", label: "🧹 Upkeep" },
  ];

  return (
    <main className="kitchen">
      <div className="k-wrap">
        <header className="k-header">
          <h1>Kitchen Inventory</h1>
          <p>Deep freezer, pantry &amp; fridge — from your photos</p>
        </header>
        <nav className="k-tabs" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? "active" : ""}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {t.badge ? <span className="k-badge">{t.badge}</span> : null}
            </button>
          ))}
        </nav>
        {store.saveError && <div className="k-alert">{store.saveError}</div>}
        {tab === "scan" && <ScanView store={store} goReview={() => setTab("review")} />}
        {tab === "review" && <ReviewView store={store} />}
        {tab === "inventory" && <InventoryView store={store} />}
        {tab === "meals" && <MealsView store={store} />}
        {tab === "shopping" && <ShoppingView store={store} />}
        {tab === "upkeep" && <UpkeepView store={store} />}
      </div>
    </main>
  );
}

/* ---------------------------------- Scan ---------------------------------- */

function ScanView({ store, goReview }: { store: KitchenStore; goReview: () => void }) {
  const { state, update } = store;
  const [location, setLocation] = useState<StorageLocation>("freezer");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  const recent = state.photos.slice(-30).reverse();

  const patchPhoto = (id: string, patch: Partial<PhotoRecord>) =>
    update((s) => ({ ...s, photos: s.photos.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const list = Array.from(files).filter((f) => f.type.startsWith("image/") || f.name.match(/\.(heic|heif)$/i));
    setBusy(true);

    const jobs: { photo: PhotoRecord; file: File }[] = list.map((file) => ({
      file,
      photo: {
        id: uid(),
        fileName: file.name,
        thumb: "",
        location,
        uploadedAt: new Date().toISOString(),
        status: "queued",
      },
    }));
    update((s) => ({ ...s, photos: [...s.photos, ...jobs.map((j) => j.photo)] }));

    let cursor = 0;
    const worker = async () => {
      while (cursor < jobs.length) {
        const { photo, file } = jobs[cursor++];
        try {
          const img = await prepareImage(file);
          patchPhoto(photo.id, { thumb: img.thumb, status: "analyzing" });
          const knownItems = Array.from(new Set(state.inventory.map((i) => i.name)));
          const result = await api<{ summary: string; items: ExtractedItem[] }>(
            "/api/kitchen/analyze",
            { imageBase64: img.base64, mediaType: img.mediaType, location, knownItems, today: today() },
          );
          update((s) => {
            const withPhoto = {
              ...s,
              photos: s.photos.map((p) =>
                p.id === photo.id ? { ...p, status: "done" as const, summary: result.summary } : p,
              ),
            };
            return addCandidates(withPhoto, photo.id, location, result.items);
          });
        } catch (err) {
          patchPhoto(photo.id, {
            status: "error",
            error: err instanceof Error ? err.message : "Analysis failed",
          });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
    setBusy(false);
  };

  const analyzing = state.photos.filter((p) => p.status === "analyzing" || p.status === "queued").length;
  const pending = state.review.filter((r) => r.status === "needs_review").length;

  return (
    <section className="k-section">
      <div className="k-card">
        <h2>Add photos</h2>
        <p className="k-muted">
          Where are these photos from? Close-ups of labels give the best results; wide shots of a
          shelf work too. Each photo is read by an AI agent that identifies products, looks up
          ingredients and allergens online, and sends everything to Review before it touches your
          inventory.
        </p>
        <div className="k-seg">
          {LOCATIONS.map((l) => (
            <button
              key={l.id}
              className={location === l.id ? "active" : ""}
              onClick={() => setLocation(l.id)}
            >
              {l.emoji} {l.label}
            </button>
          ))}
        </div>
        <div className="k-row">
          <button className="k-btn primary" onClick={() => cameraRef.current?.click()}>
            📷 Take photo
          </button>
          <button className="k-btn" onClick={() => inputRef.current?.click()}>
            🖼️ Choose from library
          </button>
        </div>
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
        {(busy || analyzing > 0) && (
          <p className="k-status">🔎 Analyzing {analyzing} photo{analyzing === 1 ? "" : "s"}… this takes 20–90 seconds each while the agent researches labels. Keep this tab open.</p>
        )}
        {pending > 0 && (
          <button className="k-btn ghost" onClick={goReview}>
            {pending} item{pending === 1 ? "" : "s"} waiting for review →
          </button>
        )}
      </div>

      {recent.length > 0 && (
        <div className="k-card">
          <h3>Recent photos</h3>
          <ul className="k-photos">
            {recent.map((p) => {
              const found = state.review.filter((r) => r.photoId === p.id).length;
              return (
                <li key={p.id}>
                  {p.thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.thumb} alt="" />
                  ) : (
                    <div className="k-thumb-ph">📷</div>
                  )}
                  <div>
                    <div className="k-strong">
                      {locLabel(p.location).emoji} {p.fileName}
                    </div>
                    <div className={`k-small ${p.status === "error" ? "k-err" : ""}`}>
                      {p.status === "queued" && "Waiting…"}
                      {p.status === "analyzing" && "Analyzing…"}
                      {p.status === "done" && `${found} item${found === 1 ? "" : "s"} found · ${p.summary ?? ""}`}
                      {p.status === "error" && p.error}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}

/* --------------------------------- Review --------------------------------- */

function ReviewView({ store }: { store: KitchenStore }) {
  const { state } = store;
  const queue = state.review.filter((r) => r.status === "needs_review");
  const photoById = useMemo(
    () => Object.fromEntries(state.photos.map((p) => [p.id, p])),
    [state.photos],
  );

  const approveConfident = () => {
    queue
      .filter((c) => c.item.confidence >= 0.85 && c.item.sources.allergens !== "unknown")
      .forEach((c) => store.approve(c.id, c.item, Boolean(c.matchInventoryId)));
  };

  if (queue.length === 0) {
    return (
      <section className="k-section">
        <div className="k-card k-empty">
          <div className="k-big">✅</div>
          <p>Nothing to review. Scan some photos to get started.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="k-section">
      <div className="k-card k-row spread">
        <div>
          <h2>{queue.length} to review</h2>
          <p className="k-muted">
            Check names, counts, sizes and allergens. Nothing is added to inventory until you approve
            it.
          </p>
        </div>
        <button className="k-btn" onClick={approveConfident}>
          Approve all ≥85% confident
        </button>
      </div>
      {queue.map((c) => (
        <ReviewCard
          key={c.id}
          cand={c}
          photo={photoById[c.photoId]}
          match={state.inventory.find((i) => i.id === c.matchInventoryId)}
          store={store}
        />
      ))}
    </section>
  );
}

const SOURCE_LABEL: Record<FieldSource, string> = {
  label: "from label",
  researched: "researched online",
  estimated: "estimated",
  unknown: "unknown",
};

function SourceTag({ s }: { s: FieldSource }) {
  return <span className={`k-src ${s}`}>{SOURCE_LABEL[s]}</span>;
}

function ReviewCard({
  cand,
  photo,
  match,
  store,
}: {
  cand: ReviewCandidate;
  photo?: PhotoRecord;
  match?: InventoryItem;
  store: KitchenStore;
}) {
  const [item, setItem] = useState<ExtractedItem>(cand.item);
  const [merge, setMerge] = useState(Boolean(match));
  const set = <K extends keyof ExtractedItem>(k: K, v: ExtractedItem[K]) =>
    setItem((i) => ({ ...i, [k]: v }));
  const toggle = (field: "allergens" | "may_contain", a: Allergen) =>
    set(field, item[field].includes(a) ? item[field].filter((x) => x !== a) : [...item[field], a]);

  const conf = Math.round(item.confidence * 100);

  return (
    <article className="k-card k-review">
      <div className="k-review-head">
        {photo?.thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={photo.thumb} alt="Source photo" className="k-review-thumb" />
        ) : null}
        <div className="grow">
          <div className="k-small">
            {locLabel(cand.location).emoji} {locLabel(cand.location).label}
          </div>
          <div className={`k-conf ${conf >= 85 ? "hi" : conf >= 60 ? "mid" : "lo"}`}>
            <span style={{ width: `${conf}%` }} />
          </div>
          <div className="k-small">{conf}% confident</div>
        </div>
      </div>

      {item.notes && <div className="k-note">⚠️ {item.notes}</div>}

      <label className="k-field">
        <span>
          Name <SourceTag s={item.sources.name} />
        </span>
        <input value={item.name} onChange={(e) => set("name", e.target.value)} />
      </label>
      <div className="k-grid2">
        <label className="k-field">
          <span>Brand</span>
          <input value={item.brand ?? ""} onChange={(e) => set("brand", e.target.value || null)} />
        </label>
        <label className="k-field">
          <span>Category</span>
          <select value={item.category} onChange={(e) => set("category", e.target.value as Category)}>
            {CATEGORIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label className="k-field">
          <span>Quantity</span>
          <input
            type="number"
            min={0}
            value={item.quantity}
            onChange={(e) => set("quantity", Math.max(0, parseInt(e.target.value || "0", 10)))}
          />
        </label>
        <label className="k-field">
          <span>
            Size <SourceTag s={item.sources.size} />
          </span>
          <input
            value={item.package_size ?? ""}
            placeholder="e.g. 16 oz"
            onChange={(e) => set("package_size", e.target.value || null)}
          />
        </label>
        <label className="k-field">
          <span>Printed date</span>
          <input
            type="date"
            value={item.printed_date ?? ""}
            onChange={(e) => set("printed_date", e.target.value || null)}
          />
        </label>
        <label className="k-field">
          <span>Date type</span>
          <select
            value={item.printed_date_type ?? ""}
            onChange={(e) =>
              set("printed_date_type", (e.target.value || null) as ExtractedItem["printed_date_type"])
            }
          >
            <option value="">—</option>
            <option value="best_by">Best by</option>
            <option value="use_by">Use by</option>
            <option value="sell_by">Sell by</option>
            <option value="packed_on">Packed / frozen on</option>
            <option value="unknown">Unknown</option>
          </select>
        </label>
      </div>

      <div className="k-field">
        <span>
          Contains allergens <SourceTag s={item.sources.allergens} />
        </span>
        <div className="k-chips">
          {MAJOR_ALLERGENS.map((a) => (
            <button
              key={a}
              className={`k-chip ${item.allergens.includes(a) ? "on danger" : ""}`}
              onClick={() => toggle("allergens", a)}
            >
              {a}
            </button>
          ))}
        </div>
      </div>
      <div className="k-field">
        <span>May contain</span>
        <div className="k-chips">
          {MAJOR_ALLERGENS.map((a) => (
            <button
              key={a}
              className={`k-chip ${item.may_contain.includes(a) ? "on warn" : ""}`}
              onClick={() => toggle("may_contain", a)}
            >
              {a}
            </button>
          ))}
        </div>
      </div>

      <label className="k-field">
        <span>
          Ingredients <SourceTag s={item.sources.ingredients} />
        </span>
        <textarea
          rows={3}
          value={item.ingredients.join(", ")}
          onChange={(e) =>
            set(
              "ingredients",
              e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
            )
          }
        />
      </label>

      {item.research_urls.length > 0 && (
        <div className="k-small">
          Sources:{" "}
          {item.research_urls.slice(0, 4).map((u) => (
            <a key={u} href={u} target="_blank" rel="noreferrer" className="k-link">
              {safeHost(u)}
            </a>
          ))}
        </div>
      )}

      {match && (
        <label className="k-merge">
          <input type="checkbox" checked={merge} onChange={(e) => setMerge(e.target.checked)} />
          Already have <b>{match.name}</b> ({match.quantity} in {locLabel(match.location).label}). Add
          to that instead of creating a new entry.
        </label>
      )}

      <div className="k-row">
        <button
          className="k-btn primary"
          disabled={!item.name.trim()}
          onClick={() => store.approve(cand.id, item, merge && Boolean(match))}
        >
          Approve
        </button>
        <button className="k-btn ghost" onClick={() => store.reject(cand.id)}>
          Not food / wrong — skip
        </button>
      </div>
    </article>
  );
}

function safeHost(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "link";
  }
}

/* -------------------------------- Inventory ------------------------------- */

function InventoryView({ store }: { store: KitchenStore }) {
  const { state } = store;
  const [loc, setLoc] = useState<StorageLocation | "all">("all");
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<Category | "">("");
  const [safeOnly, setSafeOnly] = useState(false);
  const [showEmpty, setShowEmpty] = useState(false);
  const [sort, setSort] = useState<"useBy" | "name" | "added">("useBy");
  const [open, setOpen] = useState<string | null>(null);

  const avoid = state.avoidAllergens;
  const items = state.inventory
    .filter((i) => loc === "all" || i.location === loc)
    .filter((i) => showEmpty || i.quantity > 0)
    .filter((i) => !cat || i.category === cat)
    .filter(
      (i) =>
        !safeOnly ||
        (!i.allergens.some((a) => avoid.includes(a)) && !i.may_contain.some((a) => avoid.includes(a))),
    )
    .filter((i) => {
      if (!q) return true;
      const hay = `${i.name} ${i.brand ?? ""} ${i.category} ${i.ingredients.join(" ")} ${i.shelf ?? ""}`.toLowerCase();
      return hay.includes(q.toLowerCase());
    })
    .sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name)
        : sort === "added"
          ? b.addedAt.localeCompare(a.addedAt)
          : a.useBy.localeCompare(b.useBy),
    );

  const inStock = state.inventory.filter((i) => i.quantity > 0);
  const packages = inStock.reduce((s, i) => s + i.quantity, 0);
  const useSoon = inStock.filter((i) => freshness(i.useBy) === "use soon").length;
  const expired = inStock.filter((i) => freshness(i.useBy) === "expired").length;

  return (
    <section className="k-section">
      <div className="k-stats">
        <Stat n={inStock.length} label="products" />
        <Stat n={packages} label="packages" />
        <Stat n={useSoon} label="use within 2 wks" tone={useSoon ? "warn" : undefined} />
        <Stat n={expired} label="past date" tone={expired ? "danger" : undefined} />
      </div>

      <div className="k-card">
        <div className="k-seg">
          <button className={loc === "all" ? "active" : ""} onClick={() => setLoc("all")}>
            All
          </button>
          {LOCATIONS.map((l) => (
            <button key={l.id} className={loc === l.id ? "active" : ""} onClick={() => setLoc(l.id)}>
              {l.emoji} {l.label} ({inStock.filter((i) => i.location === l.id).length})
            </button>
          ))}
        </div>
        <div className="k-filters">
          <input placeholder="Search name, brand, ingredient…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select value={cat} onChange={(e) => setCat(e.target.value as Category | "")}>
            <option value="">All categories</option>
            {CATEGORIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
            <option value="useBy">Use soonest first</option>
            <option value="name">A–Z</option>
            <option value="added">Newest first</option>
          </select>
        </div>
        <div className="k-row wrap">
          <label className="k-check">
            <input type="checkbox" checked={safeOnly} onChange={(e) => setSafeOnly(e.target.checked)} />
            Only allergy-safe {avoid.length ? `(no ${avoid.join(", ")})` : "(set allergies in Meals)"}
          </label>
          <label className="k-check">
            <input type="checkbox" checked={showEmpty} onChange={(e) => setShowEmpty(e.target.checked)} />
            Show used-up items
          </label>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="k-card k-empty">
          <p>No items match. Scan photos and approve them in Review to fill your inventory.</p>
        </div>
      ) : (
        <ul className="k-inv">
          {items.map((i) => (
            <InventoryRow
              key={i.id}
              item={i}
              open={open === i.id}
              onToggle={() => setOpen(open === i.id ? null : i.id)}
              store={store}
              avoid={avoid}
              photos={state.photos}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function Stat({ n, label, tone }: { n: number; label: string; tone?: "warn" | "danger" }) {
  return (
    <div className={`k-stat ${tone ?? ""}`}>
      <div className="n">{n}</div>
      <div className="l">{label}</div>
    </div>
  );
}

function InventoryRow({
  item,
  open,
  onToggle,
  store,
  avoid,
  photos,
}: {
  item: InventoryItem;
  open: boolean;
  onToggle: () => void;
  store: KitchenStore;
  avoid: Allergen[];
  photos: PhotoRecord[];
}) {
  const f = freshness(item.useBy);
  const d = daysUntil(item.useBy);
  const flagged = item.allergens.filter((a) => avoid.includes(a));
  const srcPhotos = photos.filter((p) => item.photoIds.includes(p.id));

  return (
    <li className={`k-card k-inv-row ${item.quantity === 0 ? "empty" : ""}`}>
      <div className="k-inv-main">
        <button className="k-inv-title" onClick={onToggle} aria-expanded={open}>
          <div className="k-strong">
            {locLabel(item.location).emoji} {item.name}
          </div>
          <div className="k-small">
            {[item.brand, item.package_size, item.category, item.shelf].filter(Boolean).join(" · ")}
          </div>
          <div className="k-tags">
            <span className={`k-fresh ${f.replace(" ", "-")}`}>
              {f === "expired" ? `${-d}d past` : d <= 60 ? `use in ${d}d` : `good till ${item.useBy}`}
            </span>
            {flagged.map((a) => (
              <span key={a} className="k-chip on danger sm">
                {a}
              </span>
            ))}
          </div>
        </button>
        <div className="k-qty">
          <button aria-label="Used one" onClick={() => store.changeQty(item.id, -1)} disabled={item.quantity === 0}>
            −
          </button>
          <span>{item.quantity}</span>
          <button aria-label="Add one" onClick={() => store.changeQty(item.id, 1)}>
            +
          </button>
        </div>
      </div>

      {open && (
        <div className="k-inv-detail">
          <p>{item.description}</p>
          <dl>
            <dt>Use by</dt>
            <dd>
              {item.useBy} ({item.useBySource === "printed" ? "printed on package" : "storage guideline"})
            </dd>
            <dt>Added</dt>
            <dd>
              {item.addedAt} by {item.reviewedBy}
            </dd>
            {item.net_weight_oz ? (
              <>
                <dt>Net weight</dt>
                <dd>
                  {item.net_weight_oz} oz each · {Math.round(item.net_weight_oz * item.quantity * 10) / 10} oz total
                </dd>
              </>
            ) : null}
            <dt>Contains</dt>
            <dd>{item.allergens.length ? item.allergens.join(", ") : "no major allergens listed"}</dd>
            {item.may_contain.length > 0 && (
              <>
                <dt>May contain</dt>
                <dd>{item.may_contain.join(", ")}</dd>
              </>
            )}
            {item.dietary_flags.length > 0 && (
              <>
                <dt>Diet</dt>
                <dd>{item.dietary_flags.join(", ")}</dd>
              </>
            )}
            <dt>Ingredients</dt>
            <dd>
              {item.ingredients.length ? item.ingredients.join(", ") : "—"}{" "}
              <SourceTag s={item.sources.ingredients} />
            </dd>
          </dl>
          <div className="k-grid2">
            <label className="k-field">
              <span>Shelf / bin</span>
              <input
                value={item.shelf ?? ""}
                placeholder="e.g. top basket"
                onChange={(e) => store.editItem(item.id, { shelf: e.target.value || null })}
              />
            </label>
            <label className="k-field">
              <span>Add to shopping list at</span>
              <input
                type="number"
                min={0}
                value={item.lowStockAt}
                onChange={(e) => store.editItem(item.id, { lowStockAt: Math.max(0, parseInt(e.target.value || "0", 10)) })}
              />
            </label>
            <label className="k-field">
              <span>Use by</span>
              <input
                type="date"
                value={item.useBy}
                onChange={(e) => e.target.value && store.editItem(item.id, { useBy: e.target.value, useBySource: "printed" })}
              />
            </label>
            <label className="k-field">
              <span>Move to</span>
              <select
                value={item.location}
                onChange={(e) => store.editItem(item.id, { location: e.target.value as StorageLocation })}
              >
                {LOCATIONS.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {srcPhotos.length > 0 && (
            <div className="k-lineage">
              <span className="k-small">From photo{srcPhotos.length > 1 ? "s" : ""}:</span>
              {srcPhotos.map((p) =>
                p.thumb ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={p.id} src={p.thumb} alt={p.fileName} title={`${p.fileName} · ${p.uploadedAt.slice(0, 10)}`} />
                ) : null,
              )}
            </div>
          )}
          <button
            className="k-btn ghost danger"
            onClick={() => {
              if (confirm(`Remove ${item.name} from inventory?`)) store.removeItem(item.id);
            }}
          >
            Remove item
          </button>
        </div>
      )}
    </li>
  );
}

/* ---------------------------------- Meals --------------------------------- */

function MealsView({ store }: { store: KitchenStore }) {
  const { state, update } = store;
  const [mealType, setMealType] = useState<MealType>("dinner");
  const [extra, setExtra] = useState("");
  const [servings, setServings] = useState(4);
  const [ideas, setIdeas] = useState<MealIdea[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toggleAvoid = (a: Allergen) =>
    update((s) => ({
      ...s,
      avoidAllergens: s.avoidAllergens.includes(a)
        ? s.avoidAllergens.filter((x) => x !== a)
        : [...s.avoidAllergens, a],
    }));

  const inStock = state.inventory.filter((i) => i.quantity > 0);
  const expiring = inStock
    .filter((i) => daysUntil(i.useBy) <= 21)
    .sort((a, b) => a.useBy.localeCompare(b.useBy));

  const generate = async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await api<{ ideas: MealIdea[] }>("/api/kitchen/meals", {
        mealType,
        servings,
        avoidAllergens: state.avoidAllergens,
        extraRequest: extra.trim() || undefined,
        items: inStock.map((i) => ({
          name: i.brand ? `${i.name} (${i.brand})` : i.name,
          location: i.location,
          quantity: i.quantity,
          package_size: i.package_size,
          useBy: i.useBy,
          allergens: i.allergens,
        })),
      });
      setIdeas(res.ideas);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  };

  const addToShopping = (names: string[]) =>
    update((s) => ({
      ...s,
      shopping: [
        ...s.shopping,
        ...names
          .filter((n) => !s.shopping.some((e) => !e.done && e.name.toLowerCase() === n.toLowerCase()))
          .map((name) => ({ id: uid(), name, location: "pantry" as const, reason: "recipe" as const, done: false })),
      ],
    }));

  return (
    <section className="k-section">
      <div className="k-card">
        <h2>What should we make?</h2>
        <div className="k-seg">
          {(["breakfast", "lunch", "dinner", "dessert", "snack"] as MealType[]).map((m) => (
            <button key={m} className={mealType === m ? "active" : ""} onClick={() => setMealType(m)}>
              {m}
            </button>
          ))}
        </div>
        <div className="k-field">
          <span>Household allergies to avoid (saved)</span>
          <div className="k-chips">
            {MAJOR_ALLERGENS.map((a) => (
              <button
                key={a}
                className={`k-chip ${state.avoidAllergens.includes(a) ? "on danger" : ""}`}
                onClick={() => toggleAvoid(a)}
              >
                {a}
              </button>
            ))}
          </div>
        </div>
        <div className="k-grid2">
          <label className="k-field">
            <span>Servings</span>
            <input type="number" min={1} max={20} value={servings} onChange={(e) => setServings(parseInt(e.target.value || "4", 10))} />
          </label>
          <label className="k-field">
            <span>Anything else?</span>
            <input value={extra} placeholder="kid-friendly, under 30 min, slow cooker…" onChange={(e) => setExtra(e.target.value)} />
          </label>
        </div>
        <button className="k-btn primary" onClick={generate} disabled={loading || inStock.length === 0}>
          {loading ? "Thinking…" : inStock.length === 0 ? "Add inventory first" : `Get ${mealType} ideas`}
        </button>
        {err && <div className="k-alert">{err}</div>}
      </div>

      {expiring.length > 0 && (
        <div className="k-card">
          <h3>Use these soon</h3>
          <ul className="k-plain">
            {expiring.slice(0, 8).map((i) => (
              <li key={i.id}>
                {locLabel(i.location).emoji} {i.name} — {daysUntil(i.useBy) < 0 ? "past date" : `${daysUntil(i.useBy)} days`}
              </li>
            ))}
          </ul>
        </div>
      )}

      {ideas.map((idea, n) => (
        <article key={n} className="k-card k-meal">
          <div className="k-row spread">
            <h3>{idea.title}</h3>
            <span className="k-small">⏱ {idea.prep_minutes} min</span>
          </div>
          {idea.uses_expiring_soon && <span className="k-fresh use-soon">uses items expiring soon</span>}
          <p>{idea.summary}</p>
          <p className="k-small">
            <b>From your kitchen:</b> {idea.uses_inventory.join(", ") || "—"}
          </p>
          {idea.needs_to_buy.length > 0 && (
            <p className="k-small">
              <b>Need to buy:</b> {idea.needs_to_buy.join(", ")}{" "}
              <button className="k-link-btn" onClick={() => addToShopping(idea.needs_to_buy)}>
                + add to shopping list
              </button>
            </p>
          )}
          <p className="k-small">
            <b>Contains:</b> {idea.allergens.length ? idea.allergens.join(", ") : "no major allergens"}
          </p>
          <details>
            <summary>Steps</summary>
            <ol>
              {idea.steps.map((s, k) => (
                <li key={k}>{s}</li>
              ))}
            </ol>
          </details>
        </article>
      ))}
    </section>
  );
}

/* -------------------------------- Shopping -------------------------------- */

function ShoppingView({ store }: { store: KitchenStore }) {
  const { state, update } = store;
  const [name, setName] = useState("");
  const [copied, setCopied] = useState(false);
  const open = state.shopping.filter((s) => !s.done);
  const done = state.shopping.filter((s) => s.done);

  const add = () => {
    if (!name.trim()) return;
    update((s) => ({
      ...s,
      shopping: [...s.shopping, { id: uid(), name: name.trim(), location: "pantry", reason: "manual", done: false }],
    }));
    setName("");
  };
  const toggle = (id: string) =>
    update((s) => ({ ...s, shopping: s.shopping.map((e) => (e.id === id ? { ...e, done: !e.done } : e)) }));

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(open.map((e) => `☐ ${e.name}`).join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  return (
    <section className="k-section">
      <div className="k-card">
        <h2>Shopping list</h2>
        <p className="k-muted">
          Items land here automatically when you use the last one (or drop to the low-stock number you
          set). When you buy them, photograph the haul in Scan; approving it clears them from this list.
        </p>
        <div className="k-row">
          <input
            className="grow"
            placeholder="Add an item"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
          <button className="k-btn primary" onClick={add}>
            Add
          </button>
        </div>
      </div>
      <div className="k-card">
        {open.length === 0 ? (
          <p className="k-muted">Nothing on the list.</p>
        ) : (
          <ul className="k-shop">
            {open.map((e) => (
              <li key={e.id}>
                <label>
                  <input type="checkbox" checked={false} onChange={() => toggle(e.id)} />
                  {e.name}
                </label>
                <span className="k-small">{e.reason}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="k-row">
          <button className="k-btn" onClick={copy} disabled={open.length === 0}>
            {copied ? "Copied!" : "Copy list"}
          </button>
          {done.length > 0 && (
            <button
              className="k-btn ghost"
              onClick={() => update((s) => ({ ...s, shopping: s.shopping.filter((e) => !e.done) }))}
            >
              Clear {done.length} checked
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

/* --------------------------------- Upkeep --------------------------------- */

function download(name: string, text: string, type: string) {
  const blob = new Blob([text], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function UpkeepView({ store }: { store: KitchenStore }) {
  const { state, update, log } = store;
  const fileRef = useRef<HTMLInputElement>(null);
  const [passcode, setPasscode] = useState(getPasscode());

  const markAudit = (l: StorageLocation) =>
    update((s) => log({ ...s, lastAuditAt: { ...s.lastAuditAt, [l]: today() } }, `finished ${l} audit`));

  const importJson = async (f: File | undefined) => {
    if (!f) return;
    try {
      const parsed = JSON.parse(await f.text()) as KitchenState;
      if (parsed.version !== 1 || !Array.isArray(parsed.inventory)) throw new Error("Not a kitchen backup");
      if (!confirm(`Replace current data with backup (${parsed.inventory.length} items)?`)) return;
      update(() => parsed);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Import failed");
    }
  };

  return (
    <section className="k-section">
      <div className="k-card">
        <h2>Audits</h2>
        <p className="k-muted">A quick monthly re-photo keeps counts honest.</p>
        <ul className="k-audits">
          {LOCATIONS.map((l) => {
            const last = state.lastAuditAt[l.id];
            const ago = last ? -daysUntil(last) : null;
            const overdue = ago === null || ago > (l.id === "pantry" ? 90 : 30);
            return (
              <li key={l.id}>
                <div>
                  <div className="k-strong">
                    {l.emoji} {l.label}
                  </div>
                  <div className={`k-small ${overdue ? "k-err" : ""}`}>
                    {last ? `Last audit ${ago} days ago` : "Never audited"}
                    {overdue ? " · due" : ""}
                  </div>
                </div>
                <button className="k-btn" onClick={() => markAudit(l.id)}>
                  Mark done today
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="k-card">
        <h2>Keeping it up to date</h2>
        <ul className="k-tips">
          {MAINTENANCE_TIPS.map((t) => (
            <li key={t.title}>
              <div className="k-row spread">
                <b>{t.title}</b>
                <span className="k-pill">{t.cadence}</span>
              </div>
              <p>{t.body}</p>
            </li>
          ))}
        </ul>
      </div>

      <div className="k-card">
        <h2>Household &amp; data</h2>
        <div className="k-grid2">
          <label className="k-field">
            <span>Your name (shown on reviews &amp; activity)</span>
            <input
              value={state.householdMember}
              onChange={(e) => update((s) => ({ ...s, householdMember: e.target.value.slice(0, 40) }))}
            />
          </label>
          <label className="k-field">
            <span>Household passcode (if the server requires one)</span>
            <input
              type="password"
              value={passcode}
              onChange={(e) => {
                setPasscode(e.target.value);
                try {
                  localStorage.setItem("kitchen-passcode", e.target.value);
                } catch {}
              }}
            />
          </label>
        </div>
        <p className="k-muted">
          Data is saved in this browser only. Export a backup to move it to another phone, or to keep a
          copy.
        </p>
        <div className="k-row wrap">
          <button className="k-btn" onClick={() => download(`kitchen-backup-${today()}.json`, JSON.stringify(state), "application/json")}>
            Export backup (JSON)
          </button>
          <button className="k-btn" onClick={() => download(`kitchen-inventory-${today()}.csv`, toCsv(state.inventory), "text/csv")}>
            Export inventory (CSV)
          </button>
          <button className="k-btn" onClick={() => fileRef.current?.click()}>
            Import backup
          </button>
          <input ref={fileRef} type="file" accept="application/json" hidden onChange={(e) => importJson(e.target.files?.[0])} />
          <button
            className="k-btn ghost"
            onClick={() =>
              update((s) => ({
                ...s,
                review: s.review.filter((r) => r.status === "needs_review"),
                photos: s.photos.filter(
                  (p) =>
                    s.inventory.some((i) => i.photoIds.includes(p.id)) ||
                    s.review.some((r) => r.photoId === p.id && r.status === "needs_review"),
                ),
              }))
            }
          >
            Clean up old photos &amp; reviews
          </button>
        </div>
      </div>

      {state.activity.length > 0 && (
        <div className="k-card">
          <h3>Recent activity</h3>
          <ul className="k-plain k-small">
            {state.activity.slice(0, 25).map((a, n) => (
              <li key={n}>
                {a.at.slice(0, 10)} · {a.who} {a.action}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
