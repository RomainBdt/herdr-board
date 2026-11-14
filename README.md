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

`./install.sh` installs two mods and one layout into `~/.config/herdr-app`:

- `herdr-board`: the board. The `board` layout has two places for it, `board-side` (a column between the sidebar
  and the chat) and `board-top` (five columns above the tabs); the Position setting picks one.
- `herdr-board-tabs`: a copy of Herdr's tab bar with a **Board** button next to Files and Changes. It shows or hides
  the board, with a red count of cards that need you while it is hidden. It is a copy: Herdr updates to its own tab
  bar don't reach it (`mod-tabs/` holds it; redo the copy with `herdr-app do mod.clone` and re-add the button if
  Herdr's changes).

Pick the layout with `Ctrl+Shift+L`. Bind `"ctrl-alt-b": "herdr-board-tabs.toggle"` in `keys.json` to show or hide
it from the keyboard (not Ctrl+B: Claude Code uses it).

### Settings (⚙ on the board)

| | |
|---|---|
| Position | beside the sidebar, or across the top |
| Clicking a card | opens its live session (✎ opens the card), or opens the card (an Open button opens the session) |
| Compact cards | To do, Ready and Done on one line |
| Show Done | |
| Refresh every | 5 s, 15 s, 1 min |
| Alerts | toast + sound when a card needs you; when one is done (off by default: Herdr already tells you) |
| Agents at once, Planner model | saved in the server's `board.json` (`herdr-board config ...`) |
| Connection | machine, path of `herdr-board.mjs` and of the board folder on it |

Display and connection settings are kept in Herdr's shared state (`herdr-board.settings`).

### Using it

- Each card shows its repo color, model, done target and its 3 "where we are" lines (◎ goal, ✓ done, → next).
  Questions show on the card in **Needs you**. Beside the sidebar, sections go most urgent first and fold
  (Done starts folded).
- **Answer** shows the questions with a box for your answers; **Send answers** delivers them to the live session.
- The card editor saves on the server and refuses if an agent changed the card meanwhile.
- **+**, **Plan**, **▶ Start next** in the header. Each card's tab is named after the card.
- Commands for `keys.json`: `herdr-board.answer` (first card with questions), `herdr-board.jump` (its session),
  `herdr-board.settings`, `herdr-board.refresh`, `herdr-board-tabs.toggle`.
