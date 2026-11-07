import Anthropic from "@anthropic-ai/sdk";

export const MODEL = "claude-opus-5-5";

// Refusal fallback: if a request is declined, the API re-runs it on Anthropic's
// recommended fallback model inside the same call.
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

let client: Anthropic | null = null;
export function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error("ANTHROPIC_API_KEY is not set on the server. Add it in your Vercel project settings (or .env.local) and redeploy.");
  }
  if (!client) client = new Anthropic(); // reads ANTHROPIC_API_KEY
  return client;
}

export function apiErrorMessage(err: unknown): { status: number; message: string } {
  if (err instanceof Anthropic.AuthenticationError) {
    return { status: 500, message: "ANTHROPIC_API_KEY is missing or invalid on the server." };
  }
  if (err instanceof Anthropic.RateLimitError) {
    return { status: 429, message: "Rate limited by the Claude API. Wait a minute and retry." };
  }
  if (err instanceof Anthropic.BadRequestError) {
    return { status: 400, message: `Claude API rejected the request: ${err.message}` };
  }
  if (err instanceof Anthropic.APIError) {
    return { status: 502, message: `Claude API error ${err.status}: ${err.message}` };
  }
  return { status: 500, message: err instanceof Error ? err.message : String(err) };
}

// Optional shared passcode. If KITCHEN_PASSCODE is set on the server, every
// kitchen API call must send it in the x-kitchen-passcode header. Keeps people
// who stumble on the URL from spending your API credits.
export function checkPasscode(req: Request): string | null {
  const expected = process.env.KITCHEN_PASSCODE;
  if (!expected) return null;
  const got = req.headers.get("x-kitchen-passcode") || "";
  return got === expected ? null : "Wrong or missing household passcode.";
}
