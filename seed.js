import { BANK_ID, createHindsight, ensureBank, logApiError } from "./lib/clients.js";
import { HISTORICAL_MEMORIES } from "./lib/history.js";

async function main() {
  const client = createHindsight();
  await ensureBank(client);

  for (const memory of HISTORICAL_MEMORIES) {
    await client.retain(BANK_ID, memory.content, {
      documentId: memory.documentId,
      context: "historical pattern for the billing-webhook ticket",
      tags: ["billing-webhook", "historical-pattern"],
      updateMode: "replace",
      async: false,
    });
    console.log(`[hindsight] Retained: ${memory.content}`);
  }

  console.log(`Seed complete. ${HISTORICAL_MEMORIES.length} memories are in "${BANK_ID}".`);
}

main().catch((err) => {
  logApiError("hindsight", err);
  process.exit(1);
});
