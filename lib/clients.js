import "dotenv/config";
import { HindsightClient } from "@vectorize-io/hindsight-client";
import OpenAI from "openai";

export const BANK_ID = "billing-webhook-shift";
export const DEFAULT_TICKET = "billing-webhook";
export const GROQ_MODEL = "openai/gpt-oss-120b";
export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(
      `Missing ${name}. Add it to .env before running seed.js or server.js.`
    );
  }
  return value.trim();
}

export function createHindsight() {
  return new HindsightClient({
    baseUrl: requireEnv("HINDSIGHT_API_URL"),
    apiKey: requireEnv("HINDSIGHT_API_KEY"),
  });
}

export function createGroq() {
  return new OpenAI({
    apiKey: requireEnv("GROQ_API_KEY"),
    baseURL: GROQ_BASE_URL,
  });
}

export function logApiError(source, err) {
  const message = err?.message || String(err);
  console.error(`[${source}] ${err?.name || "Error"}: ${message}`);
  if (err?.statusCode) console.error(`[${source}] status: ${err.statusCode}`);
  if (err?.status && err.status !== err.statusCode) {
    console.error(`[${source}] status: ${err.status}`);
  }
  if (err?.details) console.error(`[${source}] details:`, err.details);
  if (err?.error) console.error(`[${source}] error body:`, err.error);
}

export async function ensureBank(client) {
  try {
    await client.createBank(BANK_ID, {
      name: "Billing webhook shift",
      mission:
        "Remember on-call handoff notes and past incidents for the billing-webhook ticket, including causes the ticket system never recorded.",
    });
    console.log(`[hindsight] Memory bank "${BANK_ID}" is ready.`);
  } catch (err) {
    const message = err?.message || String(err);
    if (err?.statusCode === 409 || /already exists/i.test(message)) {
      console.log(`[hindsight] Memory bank "${BANK_ID}" already exists.`);
      return;
    }
    logApiError("hindsight", err);
    throw err;
  }
}
