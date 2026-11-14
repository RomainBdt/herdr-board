# herdr-board

A small kanban of Claude Code agents for Herdr. Each card is a Markdown file. Each running card is
a normal, interactive Claude Code session (a named `hc` terminal) in its own git worktree, on the machine that holds
the repos. You can open any card's session in Herdr and type into it at any time.

## What you need

- The Herdr app and herdr-core (`hc` on your PATH), on the computer you work at and on the machine with the repos
  (they can be the same computer).
- Node 18+, git and Claude Code on the machine with the repos.
- `gh` (GitHub CLI), logged in, if you use the pull-request done targets.

## Install

1. **Where the repos are ("the server")**: create a board folder with a `board.json` (see below), then
   `./deploy.sh <machine> <folder>` copies the CLI there (`<machine>` is a name from `hc machine ls`).
2. **Where you work (the laptop)**: `./install.sh` installs the panel and the layout into Herdr. Pick the layout
   with `Ctrl+Shift+L`, open ⚙ → Boards and set the machine, the path of `herdr-board.mjs` and the board folder.

## Daily use

Click **+** to make a card, fill in Context / Constraints / Done looks like, **Plan**, approve, **Start next**.
Cards that need you move to **Needs you**: answer there. The command line does the same (see Commands).

## Layout on the server

```
board/                       on the server
  board.json                 repos, colors, max parallel agents, Herdr space
  cards/DEMO-1.md            one card per file
herdr-board/                 this code, copied by ./deploy.sh
  herdr-board.mjs            the CLI (Node, no packages)
  rules.md                   what every card agent is told (autonomy, questions, done targets)
  card-template.md           a new card
  draft-rules.md             what the "Create with agent" chat is told
```

## Flow

`new` → you fill in Context / Constraints / Done looks like → `plan` (proposes model, effort, order)
→ `approve` (or `approved: true` on the card) → `next` starts cards while slots are free
→ the agent works, keeps "Where we are" up to date, and either
`ask`s (all its questions at once; card goes to **needs-you**) or calls `done`.
→ you write answers under `## Answers` and run `answer <id>` (or `answer <id> "text"`); the agent continues.
`ask` and `done` start the next card in the queue.
A done card whose agent starts a new turn (you talk to its session, 3 minutes after `done`) goes back to **running**.

Every card has a **Next action** section at the top, rewritten by the tool on each save from the status and the `done:` target:
it says whether something is on you (approve, answer, review, merge) or nothing is.

## Commands

Run on the server, or from the laptop with `hc exec --on <machine> "node <dir>/herdr-board.mjs ..."`.

| Who | Command | |
|---|---|---|
| you | `new <repo> "<title>"` | new card from the template |
| you | `draft <repo> ["<title>"]` | the "Create with agent" button: a chat agent asks what is missing, then makes the card with `new --fields-file` (never auto-approved) |
| you | `plan` | a one-shot Claude proposes model/effort/order for waiting cards |
| you | `approve <id> [--model m] [--effort e]` | ready to start (takes the proposal by default) |
| you | `next` / `start <id>` | start queued cards up to `maxParallel` / start one now |
| timer | `tick` | `next`, but only if `autoStart` is on and its interval has passed (the panel calls it every 30 s) |
| you | `show <id>` / `update <id> --hash <h> --fields <enc>` | the card's form fields as JSON / change a card that has not started (what the panel's card form uses; refuses if the file changed since `show`) |
| you | `answer <id> ["text"]` | send your answers to the live session |
| you | `ls [--json]` | the board; `--json` is what the Herdr panel reads |
| you | `clean <id>` | stop its agent and any terminal sitting in its worktree (when it has no uncommitted changes; busy folders are retried for a few seconds), then as the board's Clean settings say: remove its worktree, delete its branch, move the card to `archived` (all on by default; set with `config cleanWorktree`, `cleanBranch`, `cleanArchive` `on`/`off`) |
| agent | `where` / `ask` / `done [--state s]` | update its own card; never edits the file directly. `--state` (`reached` default, `partial`, `blocked`, `failed`, `abandoned`) decides the tag shown on a Done card: the Finish-with state reached (None, Local commit, Local + review, Draft PR, PR ready, Merged), "Blocked", or "Not reached" |

`ls` also checks each running agent: a terminal that is gone, blocked on a prompt, or stopped without `ask`/`done`
shows under **needs-you** with the reason.

## board.json

```json
{
  "name": "Payments",
  "space": "<Herdr space id on that machine: agents show up there as tabs>",
  "hcSession": "<only for a separate test core; leave out normally>",
  "maxParallel": 3,
  "permissionMode": "auto",
  "plannerModel": "sonnet",
  "autoStart": { "enabled": false, "intervalMinutes": 5 },
  "worktrees": "D:/work/worktrees",
  "repos": {
    "billing-api": { "path": "D:/work/billing-api", "prefix": "API", "base": "main", "color": "#3b82f6" }
  }
}
```

`autoStart` (default off): when `enabled`, approved cards start by themselves while slots are free, checked every
`intervalMinutes` (1 to 1440, default 5). It is the same logic as `next`: an empty queue or no free slot does nothing,
and a card that fails to start gets `start_error` as usual while the timer goes on. The timer is the panel (its copy in
the chosen slot calls `tick` on every board each 30 s), so the board's Herdr must be open; `tick` can also be run from
cron. board.json is re-read on every `tick`: changing the switch or interval, in the panel or by hand, needs no
restart. Change them with `config autoStart on|off` and `config autoInterval <minutes>`. The time of the last run is
kept in `<board>/.auto-start`. There is no quiet-hours or machine-busy condition: the agent limit is the throttle.

## Notes (Windows server)

- If the server's core won't start over SSH ("refusing to start an elevated Windows core"), start it once in a
  desktop session there (`hc server start`) or open Herdr on it.
- A new worktree opens on Claude's "trust this folder?" prompt; `start` answers yes.
- A new card branches from `origin/<base>` after a fetch when the repo has an `origin`, else from the local base.

## Trying it on one computer

You don't need a second machine: leave **Machine** empty in the settings and the board runs on this computer.
Skip `deploy.sh` then: set **Board CLI** to the `herdr-board.mjs` in this checkout.

## The board panel (Herdr, on the laptop)

`./install.sh` installs two mods and one layout into `~/.config/herdr-app`:

- `herdr-board`: the board. The `board` layout has two places for it, `board-side` (a column between the sidebar
  and the chat) and `board-top` (six columns above the tabs); the Position setting picks one.
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
| Clicking a card | opens its live session (✎ opens the card), or opens the card form (an Open button opens the session). The form is the New card form filled in; fields are changeable until the card starts, then greyed (Edit as text opens the Markdown file) |
| Compact cards | To do, Ready, Done and Archived on one line |
| Show Done | |
| Show Archived | cleaned cards, in their own column (folded by default in the side panel) |
| Refresh every | 5 s, 15 s, 1 min |
| Alerts | toast + sound when a card needs you; when one is done (off by default: Herdr already tells you) |
| Auto-start / Auto-start every | per board, saved in its `board.json`: on or off, and 1, 5, 10, 15, 30 or 60 minutes |
| Boards | one or more, each switched On or Off independently: each is a machine, the path of `herdr-board.mjs` and of the board folder on it, and its own Agents at once, Planner model and Clean button behavior (saved in that board's `board.json` with `herdr-board config ...`) |

Display and connection settings are kept in Herdr's shared state (`herdr-board.settings`).

### Several machines at once

Add a board per machine in ⚙ → Boards (e.g. this computer and a server over ssh), each with its own `board.json`,
cards and agents. The panel reads them all and shows their cards together; each card is tagged with its board and
every button (Approve, Start, Answer, Open, Clean, the card editor) runs on that card's machine. **+** asks which
board's repo the new card is for; **Plan** and **Start next** run on every board. A board that can't be read (ssh
down) keeps its last cards and shows its error in the header; the others carry on. Deploy the CLI to each machine
with `./deploy.sh` (or point the local board at this checkout).

### Using it

- Each card shows its repo color, model, done target and its 3 "where we are" lines (◎ goal, ✓ done, → next).
  Questions show on the card in **Needs you**. Beside the sidebar, sections go most urgent first and fold
  (Done starts folded).
- **Answer** shows the questions with a box for your answers; **Send answers** delivers them to the live session.
- The card editor saves on the server and refuses if an agent changed the card meanwhile.
- **+**, **Plan**, **▶ Start next** in the header. Each card's tab is named after the card.
- Commands for `keys.json`: `herdr-board.answer` (first card with questions), `herdr-board.jump` (its session),
  `herdr-board.settings`, `herdr-board.refresh`, `herdr-board-tabs.toggle`.

## Licenses and notices

herdr-board is under the license in `LICENSE`. `mod-tabs/` is a modified copy of the `tabs` mod shipped with Herdr,
which is under the Apache License 2.0; see `NOTICE`.

## Done tag colors

Every tag on a Done card has its own color:

| Tag | Color |
|---|---|
| None | gray `#9ca3af` |
| Local commit | yellow `#e5b92e` |
| Local + review | lime `#a6c93a` |
| Draft PR | light green `#5cc86a` |
| PR ready | teal `#22b8a0` |
| Merged | strong green `#15a34a` |
| Done (target in plain words) | blue `#7b93e0` |
| Blocked | orange `#f97316` |
| Not reached | red `#ef4444` |
