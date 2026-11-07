# Calvin Turns The Big One — Photo Upload App

A no-login photo & video upload page for Calvin's 1st birthday. Guests scan a QR code, pick photos from their phone, and the files land in a Google Shared Drive owned by you.

## How it works

1. Guest opens the page, optionally types their name, picks photos/videos
2. For each file, the browser asks `/api/create-upload` for a one-shot upload URL
3. Server uses a service account to ask Google Drive for a **resumable upload session**, gets back a URL
4. Browser uploads file bytes **directly to Google** (bypasses Vercel's 4.5 MB body limit)
5. File appears in your Shared Drive, prefixed with the guest's name if they entered one

Up to 500 files per session, no individual file size cap, 3 concurrent uploads.

## Local development

```bash
npm install
cp .env.local.example .env.local
# Edit .env.local: paste the FULL JSON service account key (one line) and the Shared Drive ID
npm run dev
```

Open http://localhost:3000.

## Deploy to Vercel

1. Push this repo to GitHub
2. Import the repo at https://vercel.com/new
3. Add two environment variables in the Vercel project settings:
   - `GOOGLE_SERVICE_ACCOUNT_KEY` — paste the entire JSON file contents (Vercel accepts multi-line)
   - `DRIVE_FOLDER_ID` — the ID of your Shared Drive (from the URL after `/folders/`)
4. Deploy

## Banner image

Drop the painted "Calvin Turns The Big One" banner at `public/banner.png` and it'll show up at the top. If missing, a CSS fallback renders instead.

## Generating the QR code

Once deployed, point a QR generator at the Vercel URL (e.g. `https://calvin-uploads.vercel.app`). Any free QR generator works. Print it big.

## Where the files go

Uploaded files land in a Google Workspace Shared Drive that you've shared with the service account (as Content Manager). Files are owned by the Shared Drive itself, so they count against your Workspace storage pool and survive even if the service account is later deleted.

## Security notes

- The service account key file is sensitive — never commit it. `.gitignore` blocks `service-account*.json` and any `.env*.local`.
- The `drive.file` scope is used, so the service account can only see files it created — not your other Drive contents.
- No guest authentication. If you share the URL publicly, anyone can upload. Take the page down after the event by removing the Vercel deployment.

---

# Kitchen Inventory (`/kitchen`)

A second app in this repo: photograph your deep freezer, pantry and fridge, and an AI agent turns each photo into reviewed inventory records.

## What it does

| Tab | Purpose |
|---|---|
| **Scan** | Pick the location (freezer / pantry / fridge), take or choose photos. Each photo is shrunk in the browser and sent to `/api/kitchen/analyze`. |
| **Review** | Every item the agent found waits here. You check the name, brand, count, package size, printed date, ingredients and allergens before anything enters inventory. Each field shows where it came from: *from label*, *researched online*, *estimated*, or *unknown*. Low-confidence items carry a note. If the product is already in inventory, you can merge the count instead of creating a duplicate. |
| **Inventory** | Search and filter by location, category, or "allergy-safe only". Tap − when you use something. Each item shows a use-by date (printed date, or a USDA-style storage guideline when there isn't one), plus the photos it came from. |
| **Meals** | Breakfast / lunch / dinner / dessert / snack ideas built from what you have. Avoids the household's allergens and favors items that expire soon. Missing ingredients go to the shopping list in one tap. |
| **Shopping** | Things you used up (or that dropped below the low-stock number you set) are added automatically. When you photograph the new groceries and approve them, they come off the list. |
| **Upkeep** | Monthly audit tracker, freezer and pantry maintenance tips, JSON/CSV export and import, activity log. |

## How the photo agent works

`app/api/kitchen/analyze/route.ts` sends the image to Claude (`claude-opus-5-5`) with two tools:

1. **Web search**: looks up the official ingredient list and allergen statement for branded products whose label isn't legible in the photo.
2. **`record_items`**: a strict JSON schema the agent must fill in for each product: name, brand, category, quantity, package size, net weight in ounces, ingredients, contains / may-contain allergens (FDA Big 9), printed date and its type, the source of each field, a confidence score, reviewer notes, and research URLs.

## Setup

Add to `.env.local` (and to Vercel project settings):

```
ANTHROPIC_API_KEY=sk-ant-...
KITCHEN_PASSCODE=optional-shared-secret
```

If `KITCHEN_PASSCODE` is set, each phone enters it once in **Upkeep → Household passcode**. Without one, anyone who finds the URL can spend your API credits.

## Where data lives

All inventory data is in the browser's `localStorage` on each device. Use **Upkeep → Export backup** to move data to another phone. Photos are kept only as small thumbnails, so you can see where each record came from. Full-size images are never stored.
