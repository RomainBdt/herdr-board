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
- A new card branches from `origin/<base>` after a fetch when the repo has an `origin`, else from the local base.

## Testing on one laptop (fake server)

OpenSSH Server on the laptop, listening on 127.0.0.1 only (`C:\fake-server\setup-sshd.ps1`), an ssh Host `fakeserver`,
and `hc machine add fakeserver --name server --session fakeserver`. After each reboot, in an admin PowerShell
`Start-Service sshd`, then in a normal terminal `HC_SESSION=fakeserver hc server start` (the elevated SSH login may not
start it while you are signed in at the desktop). `Stop-Service sshd` when done testing.

## The board panel (Herdr, on the laptop)

`./install.sh` copies the panel mod (`mod/` → `~/.config/herdr-app/mods/herdr-board`) and the `board` layout (Herdr's
main layout with the board across the top of the work area). Pick it with `Ctrl+Shift+L`. Set the board block's
`props` in `layouts/board.json`: `machine` (from `hc machine ls`), `script` and `board` (paths on that machine).

- Five columns; each card shows its repo color, model, done target and its 3 "where we are" lines
  (◎ goal, ✓ done, → next). Questions show on the card in **Needs you**.
- **Open** jumps to the card's live session: type to take over. Each card's tab is named after it.
- **Answer** shows the questions with a box for your answers; **Send answers** delivers them to the session.
- Clicking a card opens the full card in an editor (saved on the server; refused if an agent changed it meanwhile).
- **+ New card**, **Plan**, **Start next** in the header. A toast and a sound when a card needs you or is done.
- Keys you can bind in `keys.json`: `herdr-board.answer` (first card with questions), `herdr-board.jump`
  (its session), `herdr-board.refresh`.
- It reads `herdr-board ls --json` from the server every 5 seconds.
