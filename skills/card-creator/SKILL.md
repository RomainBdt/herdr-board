---
name: card-creator
description: Turn a request into a herdr-board card (Context, Constraints, Done looks like, done target) and choose its model and effort when it is created. Use when the person asks to create, add, or write a card, task, or ticket for a herdr board.
---

# Create a herdr-board card

You turn the person's request into one card on their herdr board. The person reads the card before approving it, so keep it short.

## Rules

- Use only what the person said or what you can see in the repo. Do not invent files, links, constraints or requirements. If a field is unknown, leave it empty.
- Do not add scope the person did not ask for.
- Never approve the card. The person approves it.
- Ask at most 3 short questions, in one message, and only when the card cannot be written without the answer. If the request is clear, ask nothing.

## Fields

| Field | What goes in it |
|---|---|
| `title` | Short. |
| `context` | Why it matters, what is known, files to look at. The person's own words first. |
| `constraints` | What the agent must not do or change. Bullets. |
| `doneLooks` | What the person will check to call it done. Bullets. |
| `done` | How far the agent goes: `none` (answer only), `local` (committed), `local-reviewed` (committed and reviewed), `draft-pr`, `pr-ready` (default), `merged`. Or plain words. |
| `model` | `haiku`, `sonnet` or `opus` (see below). |
| `effort` | `low`, `medium`, `high` or `xhigh` (see below). |

## Choose the model and effort

Always fill both, so the board does not need its own Haiku call when the card is approved.

| Model | Use it for |
|---|---|
| `haiku` | Trivial or mechanical work: a typo, a rename, a one-line config. |
| `sonnet` | Normal work: a feature or fix in a few files. The default. |
| `opus` | Hard, risky or large work: a design choice, a migration, many files, security. |

| Effort | Use it for |
|---|---|
| `low` | Almost no thinking needed. |
| `medium` | Clear, ordinary work. |
| `high` | Several files, careful reading, or a test to write. |
| `xhigh` | Hard problems where a mistake is costly. |

Pick the lowest pair that does the job. Do not use `max`.

## Create it

1. Show the card in a short summary, with the model and effort and one line on why. Ask "Create it?". A yes is enough.
2. Write this JSON to a temporary file (`approved` stays `false`):

   ```json
   {"title":"Short title","context":"...","constraints":"- ...","doneLooks":"- ...","done":"pr-ready","model":"sonnet","effort":"medium","approved":false}
   ```

3. Run `node <herdr-board.mjs> --board <board folder> new <repo> "<title>" --fields-file <that file>`.
   `<herdr-board.mjs>` is the CLI file of the herdr-board checkout (on the server when the board lives there; ask the person if you
   cannot find it). The board folder is `$HERDR_BOARD` if set, otherwise ask the person. `<repo>` is a repo name from its `board.json`.
4. Tell the person the card id and that it waits for their approval. Stop.
