import { JWT } from "google-auth-library";

let cachedClient: JWT | null = null;

function normalizeKey(raw: string): string {
  let k = raw.trim();
  // Strip a single layer of surrounding quotes (single or double) if pasted that way
  if (
    (k.startsWith('"') && k.endsWith('"')) ||
    (k.startsWith("'") && k.endsWith("'"))
  ) {
    k = k.slice(1, -1);
  }
  // Convert literal \n sequences to real newlines (handles env vars that escape them)
  k = k.replace(/\\n/g, "\n");
  // Some hosts collapse all whitespace — restore newlines around PEM markers if missing
  if (!k.includes("\n")) {
    k = k
      .replace(/-----BEGIN ([A-Z ]+)-----\s*/g, "-----BEGIN $1-----\n")
      .replace(/\s*-----END ([A-Z ]+)-----/g, "\n-----END $1-----");
  }
  return k;
}

function loadCreds(): { clientEmail: string; privateKey: string } {
  const splitEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const splitKey = process.env.GOOGLE_PRIVATE_KEY;
  if (splitEmail && splitKey) {
    return {
      clientEmail: splitEmail.trim(),
      privateKey: normalizeKey(splitKey),
    };
  }

  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) {
    throw new Error(
      "Missing credentials: set GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY, or GOOGLE_SERVICE_ACCOUNT_KEY",
    );
  }

  let parsed: { client_email?: string; private_key?: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON (starts with: ${raw.slice(0, 30)}...)`,
    );
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("Service account JSON missing client_email or private_key");
  }
  return {
    clientEmail: parsed.client_email,
    privateKey: normalizeKey(parsed.private_key),
  };
}

export function getAuthClient(): JWT {
  if (cachedClient) return cachedClient;

  const { clientEmail, privateKey } = loadCreds();

  cachedClient = new JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/drive.file"],
  });

  return cachedClient;
}

export async function getAccessToken(): Promise<string> {
  const client = getAuthClient();
  const token = await client.getAccessToken();
  if (!token.token) throw new Error("Failed to obtain access token");
  return token.token;
}
