# herdr-board

A small kanban of Claude Code agents for Herdr. Each card is a Markdown file. Each running card is a normal,
interactive Claude Code session (a named `hc` terminal) in its own git worktree, on the machine that holds the repos.
You can open any card's session in Herdr and type into it at any time.

```
board/                       on the server
  board.json                 repos, colors, max parallel agents, Herdr space
  cards/DEMO-1.md            one card per file
herdr-board/                 this code, copied by ./deploy.sh
  herdr-board.mjs            the CLI (Node, no packages)
  rules.md                   what every card agent is told (autonomy, questions, done targets)
  card-template.md           a new card
```

## Flow

`new` → you fill in Context / Constraints / Done looks like → `plan` (proposes model, effort, order)
→ `approve` (or `approved: true` on the card) → `next` starts cards while slots are free
→ the agent works, keeps "Where we are" up to date, and either
`ask`s (all its questions at once; card goes to **needs-you**) or calls `done`.
→ you write answers under `## Answers` and run `answer <id>` (or `answer <id> "text"`); the agent continues.
`ask` and `done` start the next card in the queue.

## Commands

Run on the server, or from the laptop with `hc exec --on <machine> "node <dir>/herdr-board.mjs ..."`.

| Who | Command | |
|---|---|---|
| you | `new <repo> "<title>"` | new card from the template |
| you | `plan` | a one-shot Claude proposes model/effort/order for waiting cards |
| you | `approve <id> [--model m] [--effort e]` | ready to start (takes the proposal by default) |
| you | `next` / `start <id>` | start queued cards up to `maxParallel` / start one now |
| you | `answer <id> ["text"]` | send your answers to the live session |
| you | `ls [--json]` | the board; `--json` is what the Herdr panel reads |
| you | `clean <id>` | stop its agent, remove its worktree (keeps the branch) |
| agent | `where` / `ask` / `done` | update its own card; never edits the file directly |

`ls` also checks each running agent: a terminal that is gone, blocked on a prompt, or stopped without `ask`/`done`
shows under **needs-you** with the reason.

## board.json

```json
{
  "name": "Payments",
  "space": "<Herdr space id on that machine: agents show up there as tabs>",
  "hcSession": "<only for a test core; leave out on a real server>",
  "maxParallel": 3,
  "permissionMode": "auto",
  "plannerModel": "sonnet",
  "worktrees": "D:/work/worktrees",
  "repos": {
    "billing-api": { "path": "D:/work/billing-api", "prefix": "API", "base": "main", "color": "#3b82f6" }
  }
}
```

## Notes (Windows server)

- If the server's core won't start over SSH ("refusing to start an elevated Windows core"), start it once in a
  desktop session there (`hc server start`) or open Herdr on it.
- A new worktree opens on Claude's "trust this folder?" prompt; `start` answers yes.
