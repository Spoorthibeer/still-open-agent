import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import {
  BANK_ID,
  DEFAULT_TICKET,
  GROQ_MODEL,
  createGroq,
  createHindsight,
  ensureBank,
  logApiError,
} from "./lib/clients.js";
import { HISTORICAL_MEMORIES } from "./lib/history.js";

const PORT = Number(process.env.PORT) || 3000;
const app = express();
const hindsight = createHindsight();
const groq = createGroq();

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");

app.use(express.json({ limit: "32kb" }));

const SYSTEM_PROMPT = `You are Still Open, an on-call shift-handoff assistant.
The ticket system says the ticket is Resolved. Ignore that status.
Answer "Can I close this shift?" using only the recalled memories.

Classify each memory as one of:
- MASKING: the problem was hidden rather than fixed. Disabling or muting an alert, closing or resolving the ticket without addressing the root cause, calling it healthy or quiet while the cause is still present, a webhook left disabled, a later cron that will page, or a ticket closed and then reopened.
- GENUINE FIX: the root cause was actually addressed and checked. Re-enabling monitoring or the webhook, a test that passed, or an explicit confirmation that the root cause was fixed and verified.
- OTHER: neither of those.

Saying only "resolved" or "looks healthy" is MASKING unless the same memory also describes a genuine fix with verification.

Recency:
- Memories are not listed in time order. Use dates in the text. A memory whose context is "live shift handoff note" is newer than a memory whose context is a historical pattern.
- If several handoff notes exist, the one with the latest time is the newest.
- Weigh that newest relevant memory more heavily when it directly contradicts the older pattern.

Verdict:
- If the newest relevant memory is a GENUINE FIX and it addresses the same cause the older MASKING memories describe, latestResolves is true. The answer must start with "Yes, safe to close" and must include the sentence "The latest note indicates this was actually fixed." Older false closes do not keep the verdict at No, stay once that verified fix is the newest memory.
- If the newest relevant memory is MASKING, latestResolves is false. Two or more distinct MASKING incidents, including that newest note when it continues the pattern, means the answer must start with "No, stay" and must include the sentence "The pattern continues."
- If there is no resolving fix and fewer than two distinct MASKING incidents, latestResolves is false and the answer must start with "Yes, safe to close."
- Older historical incidents on different days each count as their own MASKING incident. Tuesday's reopen and Wednesday's close-while-disabled are two incidents, even when another memory summarizes both in one sentence.
- If those two older incidents are present and the newest memory is also MASKING, evidenceCount is at least 2, latestResolves is false, and the answer starts with "No, stay". Do not answer "Yes, safe to close" in that case.
- citedIndexes are 1-based indexes of the memories you used. evidenceCount must equal citedIndexes.length.
- Do not invent incidents.

Return JSON only:
{"answer":"...","evidenceCount":0,"citedIndexes":[],"latestResolves":false}`;

function memoryView(result, index) {
  return {
    index,
    id: result?.id ?? null,
    text: result?.text || "",
    type: result?.type ?? null,
    context: result?.context ?? null,
  };
}

function publicMemory(memory) {
  return {
    id: memory.id,
    text: memory.text,
    type: memory.type,
    context: memory.context,
  };
}

function groupByIncident(results) {
  const groups = new Map();
  for (const result of results) {
    if (!result?.text) continue;
    const key = result.document_id || result.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(result);
  }

  return [...groups.values()].map((facts, offset) => {
    const texts = [...new Set(facts.map((fact) => fact.text.trim()).filter(Boolean))];
    return memoryView(
      {
        id: facts[0].document_id || facts[0].id,
        text: texts.join("\n"),
        type: facts[0].type,
        context: facts[0].context,
      },
      offset + 1
    );
  });
}

async function recallTicket(ticket) {
  const response = await hindsight.recall(
    BANK_ID,
    `Everything known about the ${ticket} ticket: closures, reopenings, a disabled webhook, cron pages, shift handoff notes, re-enabled monitoring, tests that passed, and verified fixes.`,
    { budget: "high", maxTokens: 8192 }
  );
  const results = Array.isArray(response?.results) ? response.results : [];
  return groupByIncident(results);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listDocumentIds() {
  const ids = [];
  let offset = 0;
  for (;;) {
    const page = await hindsight.listDocuments(BANK_ID, { limit: 100, offset });
    const items = Array.isArray(page?.items) ? page.items : [];
    for (const item of items) {
      if (item?.id) ids.push(item.id);
    }
    if (items.length < 100) return ids;
    offset += items.length;
  }
}

const RECALL_RETRY_MS = [0, 600, 1200, 2000, 3000, 4000, 5000];

async function recallBankMemories(ticket, documentId) {
  let aligned = [];
  for (let attempt = 0; attempt < RECALL_RETRY_MS.length; attempt += 1) {
    if (RECALL_RETRY_MS[attempt]) await sleep(RECALL_RETRY_MS[attempt]);
    const [documentIds, recalled] = await Promise.all([
      listDocumentIds(),
      recallTicket(ticket),
    ]);
    const byId = new Map(recalled.map((memory) => [memory.id, memory]));
    const ids = documentIds.slice();
    if (documentId && byId.has(documentId) && !ids.includes(documentId)) {
      ids.push(documentId);
    }
    aligned = ids
      .filter((id) => byId.has(id))
      .map((id, index) => ({ ...byId.get(id), index: index + 1 }));
    const missing = documentIds.filter((id) => !byId.has(id));
    const noteReady = !documentId || byId.has(documentId);
    if (missing.length === 0 && noteReady) return aligned;
    console.log(
      `[hindsight] Recall is behind the bank (${missing.join(", ") || documentId}). Retrying.`
    );
  }
  if (documentId && !aligned.some((memory) => memory.id === documentId)) {
    console.error(`[hindsight] ${documentId} was still not recallable after retries.`);
  }
  return aligned;
}

function extractJson(raw) {
  const trimmed = String(raw || "").trim();
  if (trimmed.startsWith("{")) return trimmed;
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error("Groq did not return JSON.");
  }
  return match[0];
}

function withSentence(answer, sentence) {
  if (answer.toLowerCase().includes(sentence.toLowerCase().replace(/\.$/, ""))) return answer;
  const trimmed = answer.replace(/[.\s]+$/, "");
  return trimmed ? `${trimmed}. ${sentence}` : sentence;
}

function decide(memories, parsed) {
  let answer = typeof parsed?.answer === "string" ? parsed.answer.trim() : "";
  const latestResolves = parsed?.latestResolves === true;
  const evidenceCount = memories.length;

  if (latestResolves) {
    if (!/^yes,\s*safe to close\b/i.test(answer)) {
      answer = "Yes, safe to close.";
    }
    answer = withSentence(answer, "The latest note indicates this was actually fixed.");
  } else if (evidenceCount >= 2) {
    if (!/^no,\s*stay\b/i.test(answer)) {
      answer = "No, stay.";
    }
    answer = withSentence(answer, "The pattern continues.");
  } else if (!/^yes,\s*safe to close\b/i.test(answer)) {
    answer = "Yes, safe to close.";
  }

  return {
    answer,
    citedMemories: memories.map(publicMemory),
    evidenceCount,
  };
}

async function complete(messages) {
  const request = {
    model: GROQ_MODEL,
    temperature: 0,
    max_completion_tokens: 8192,
    reasoning_effort: "low",
    messages,
  };

  try {
    return await groq.chat.completions.create({
      ...request,
      response_format: { type: "json_object" },
    });
  } catch (err) {
    if (err?.status !== 400) throw err;
    console.error(
      "[groq] JSON response format was rejected. Retrying without response_format.",
      err.message
    );
    return groq.chat.completions.create(request);
  }
}

function completionText(completion) {
  const message = completion?.choices?.[0]?.message;
  const content = typeof message?.content === "string" ? message.content.trim() : "";
  if (content) return content;

  const reasoning = typeof message?.reasoning === "string" ? message.reasoning : "";
  const jsonMatch = reasoning.match(/\{[\s\S]*\}/);
  if (jsonMatch) return jsonMatch[0];

  const preview = JSON.stringify(message);
  console.error("[groq] Empty completion:", preview ? preview.slice(0, 800) : "(no message)");
  throw new Error("Groq returned an empty completion.");
}

async function reasonAboutShift(ticket, memories) {
  const completion = await complete([
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: JSON.stringify(
        {
          ticket,
          question: "Can I close this shift?",
          memories: memories.map(({ index, text, type, context }) => ({
            index,
            text,
            type,
            context,
          })),
        },
        null,
        2
      ),
    },
  ]);

  const raw = completionText(completion);

  let parsed;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch (err) {
    console.error("[groq] Could not parse completion:", raw);
    throw err;
  }

  return decide(memories, parsed);
}

app.post("/handoff-note", async (req, res) => {
  const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
  if (!note) {
    return res.status(400).json({ error: "A text note is required." });
  }

  const documentId = `handoff-${Date.now()}`;
  try {
    await hindsight.retain(BANK_ID, note, {
      documentId,
      context: "live shift handoff note",
      tags: ["billing-webhook", "handoff-note"],
      timestamp: new Date(),
      metadata: { source: "handoff-note" },
      async: false,
    });
    console.log(`[hindsight] Retained handoff note ${documentId}.`);
    await recallBankMemories(DEFAULT_TICKET, documentId);
    return res.json({ ok: true, documentId });
  } catch (err) {
    logApiError("hindsight", err);
    return res.status(502).json({ error: "Could not retain the handoff note." });
  }
});

app.post("/can-i-close", async (req, res) => {
  const ticket =
    typeof req.body?.ticket === "string" && req.body.ticket.trim()
      ? req.body.ticket.trim()
      : DEFAULT_TICKET;

  const documentId =
    typeof req.body?.documentId === "string" ? req.body.documentId.trim() : "";

  let memories;
  try {
    memories = await recallBankMemories(ticket, documentId);
    console.log(`[hindsight] Recalled ${memories.length} memories for "${ticket}".`);
    for (const memory of memories) {
      console.log(`[hindsight] ${memory.index}. ${memory.text}`);
    }
  } catch (err) {
    logApiError("hindsight", err);
    return res.status(502).json({ error: "Could not recall memories from Hindsight." });
  }

  try {
    const decision = await reasonAboutShift(ticket, memories);
    console.log(
      `[groq] ${ticket}: evidence ${decision.evidenceCount}. ${decision.answer}`
    );
    return res.json(decision);
  } catch (err) {
    logApiError("groq", err);
    return res.status(502).json({ error: "Could not reason about this shift." });
  }
});

async function deleteAllDocuments() {
  for (;;) {
    const page = await hindsight.listDocuments(BANK_ID, { limit: 100, offset: 0 });
    const items = Array.isArray(page?.items) ? page.items : [];
    if (items.length === 0) return;
    for (const item of items) {
      if (!item?.id) continue;
      await hindsight.deleteDocument(BANK_ID, item.id);
      console.log(`[hindsight] Deleted document ${item.id}.`);
    }
  }
}

app.post("/reset-demo", async (_req, res) => {
  try {
    try {
      await hindsight.deleteBank(BANK_ID);
      console.log(`[hindsight] Cleared bank "${BANK_ID}".`);
    } catch (err) {
      logApiError("hindsight", err);
      console.error("[hindsight] deleteBank failed. Deleting documents instead.");
    }

    await ensureBank(hindsight);
    await deleteAllDocuments();

    for (const memory of HISTORICAL_MEMORIES) {
      await hindsight.retain(BANK_ID, memory.content, {
        documentId: memory.documentId,
        context: "historical pattern for the billing-webhook ticket",
        tags: ["billing-webhook", "historical-pattern"],
        updateMode: "replace",
        async: false,
      });
      console.log(`[hindsight] Re-seeded: ${memory.content}`);
    }

    return res.json({ ok: true, seeded: HISTORICAL_MEMORIES.length });
  } catch (err) {
    logApiError("hindsight", err);
    return res.status(502).json({ error: "Could not reset the demo bank." });
  }
});

app.use(express.static(publicDir));

ensureBank(hindsight)
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Still Open listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    logApiError("hindsight", err);
    process.exit(1);
  });
