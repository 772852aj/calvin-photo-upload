import { NextRequest, NextResponse } from "next/server";
import { getAccessToken } from "@/lib/google-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CreateUploadBody {
  filename: string;
  mimeType: string;
  size: number;
  guestName?: string;
}

export async function POST(req: NextRequest) {
  let body: CreateUploadBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { filename, mimeType, size, guestName } = body;

  if (!filename || !mimeType || typeof size !== "number") {
    return NextResponse.json(
      { error: "filename, mimeType, and size are required" },
      { status: 400 },
    );
  }

  const folderId = process.env.DRIVE_FOLDER_ID;
  if (!folderId) {
    return NextResponse.json(
      { error: "DRIVE_FOLDER_ID not configured" },
      { status: 500 },
    );
  }

  const safeGuest = (guestName || "").replace(/[^\p{L}\p{N} _.-]/gu, "").slice(0, 40).trim();
  const prefix = safeGuest ? `${safeGuest} — ` : "";
  const driveFilename = `${prefix}${filename}`;

  let accessToken: string;
  try {
    accessToken = await getAccessToken();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Auth error:", err);
    return NextResponse.json(
      { error: "Auth failed", detail: msg },
      { status: 500 },
    );
  }

  const metadata = {
    name: driveFilename,
    parents: [folderId],
  };

  const origin =
    req.headers.get("origin") ||
    (req.headers.get("host") ? `https://${req.headers.get("host")}` : "");

  const initRes = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": mimeType,
        "X-Upload-Content-Length": String(size),
        ...(origin ? { Origin: origin } : {}),
      },
      body: JSON.stringify(metadata),
    },
  );

  if (!initRes.ok) {
    const text = await initRes.text();
    console.error("Drive resumable init failed:", initRes.status, text);
    return NextResponse.json(
      { error: "Failed to create upload session", detail: text },
      { status: 502 },
    );
  }

  const uploadUrl = initRes.headers.get("Location");
  if (!uploadUrl) {
    return NextResponse.json(
      { error: "No upload URL returned" },
      { status: 502 },
    );
  }

  return NextResponse.json({ uploadUrl });
}
