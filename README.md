# Still Open

Still Open is an on-call shift-handoff assistant. An outgoing operator leaves a note about a ticket. The incoming operator asks whether the shift can close. The agent answers from memory of what actually happened, including caveats the ticket system never recorded. The ticket card stays **Resolved** the whole time.

This demonstrates AI agent memory using Hindsight's retain / recall / reflect pattern:

- **Retain** stores what happened. `seed.js` writes two historical incidents, and `POST /handoff-note` stores a live handoff note, both in the `billing-webhook-shift` bank.
- **Recall** pulls those memories back when someone asks about the ticket.
- **Reflect** is the reasoning step. Recalled memories and the question "Can I close this shift?" go to Groq (`openai/gpt-oss-120b`). Two or more independent false-close incidents produce "No, stay". Fewer than that produces "Yes, safe to close."

## Setup

Create a `.env` file (see `.env.example`) with:

- `HINDSIGHT_API_KEY`
- `HINDSIGHT_API_URL`
- `GROQ_API_KEY`

Then:

```bash
npm install
node seed.js
node server.js
```

Open http://localhost:3000.

`node seed.js` is meant to be run once. It retains two generic historical memories and does not mention a person or "tonight". Running it again replaces those same two documents instead of stacking duplicates.

## Endpoints

### `POST /handoff-note`

```json
{ "note": "Priya disabled the billing webhook at 18:40. It looks healthy. The 02:00 billing cron will page when it runs." }
```

Retains the note into `billing-webhook-shift`.

### `POST /can-i-close`

Optional body: `{ "ticket": "billing-webhook" }`. The ticket defaults to `billing-webhook`.

Recalls memories for that ticket, asks the model if the shift can close, and returns:

```json
{
  "answer": "No, stay. ...",
  "citedMemories": [],
  "evidenceCount": 3
}
```

Hindsight and Groq failures are logged on the server with a `[hindsight]` or `[groq]` prefix and returned as a short JSON error.
