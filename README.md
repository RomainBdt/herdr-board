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
  draft-rules.md             what the "Create with agent" chat is told
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
| timer | `tick` | `next`, but only if `autoStart` is on and its interval has passed (the panel calls it every 30 s) |
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

## Testing on one laptop (fake server)

A user-level OpenSSH server on the laptop (no admin, no service), in `~/fake-server`:

```sh
mkdir -p ~/fake-server && cd ~/fake-server
ssh-keygen -q -t ed25519 -N "" -f id_fake && ssh-keygen -q -t ed25519 -N "" -f hostkey && cp id_fake.pub authorized_keys
cat > sshd_config <<EOF
Port 2222
ListenAddress 127.0.0.1
HostKey C:/Users/<you>/fake-server/hostkey
PasswordAuthentication no
AuthorizedKeysFile C:/Users/<you>/fake-server/authorized_keys
StrictModes no
EOF
/c/Windows/System32/OpenSSH/sshd.exe -f C:/Users/<you>/fake-server/sshd_config -D &   # again after each reboot
```

Add to `~/.ssh/config`: `Host fakeserver` / `HostName 127.0.0.1` / `Port 2222` / `IdentityFile ~/fake-server/id_fake`.
Then:

```sh
hc machine add fakeserver --name fakeserver --session fakeserver
HC_SESSION=fakeserver hc server start
git init ~/fake-server/fake-project          # the fake project (commit something in it)
hc run --on fakeserver --bg --no-parent --outlive-parent --name fake-project --cwd ~/fake-server/fake-project --keep
```

The machine and its `fake-project` terminal then show up in Herdr. Stop: `hc machine rm fakeserver` and end `sshd.exe`.

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
| Auto-start / Auto-start every | per board, saved in its `board.json`: on or off, and 1, 5, 10, 15, 30 or 60 minutes |
| Boards | one or more: each is a machine, the path of `herdr-board.mjs` and of the board folder on it, and its own Agents at once and Planner model (saved in that board's `board.json` with `herdr-board config ...`) |

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
