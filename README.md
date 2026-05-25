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
