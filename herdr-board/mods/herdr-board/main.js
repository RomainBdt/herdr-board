// herdr-board panel: the cards of one or more boards (this computer, machines over ssh), read from each one's herdr-board CLI.
// The layout has two slots for it, props {slot: "side"} (a column beside the sidebar) and {slot: "top"}
// (six columns above the tabs); the Position setting picks one and only that copy runs.
// The same mod also draws its dialogs (settings, card editor, answers, new card) when opened as an overlay.
// Settings live in Herdr's shared state ("herdr-board.settings"), so the tab bar's Board button sees them too.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, EditorState, Editor, TextareaState, Textarea } from "gpui-base";
import { exec, run, props, theme, settings, notify, playSound, openOverlay, closeOverlay, readTextFile, shared, setShared, agents, nextCommand, layout, machines } from "herdr";

const COLUMNS = [
  ["todo", "To do"], ["ready", "Ready"], ["running", "Running"], ["needs-you", "Needs you"], ["done", "Done"], ["archived", "Archived"],
];
// the board's "done:" targets and their labels (the New card chips and the Done tag both use them)
const FINISH_WITH = [["none", "None"], ["local", "Local commit"], ["local-reviewed", "Local + review"], ["draft-pr", "Draft PR"], ["pr-ready", "PR ready"], ["merged", "Merged"]];
const REACHED = Object.fromEntries(FINISH_WITH);
// one color per reached state, so the Done tags are told apart at a glance
const REACHED_COLOR = { none: "#9ca3af", local: "#e5b92e", "local-reviewed": "#a6c93a", "draft-pr": "#5cc86a", "pr-ready": "#22b8a0", merged: "#15a34a" };
// the other tags: Done (target in plain words) blue, Blocked orange, Not reached red; none shares a color with another tag
const TAG_COLOR = { done: "#7b93e0", blocked: "#f97316", missed: "#ef4444" };
const BUMP ="herdr-board.bump";     // dialogs set it after a change so the board refreshes at once

// same as textHash in herdr-board.mjs: the editor sends it back so a card an agent changed isn't overwritten
function textHash(t) { let h = 5381; for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0; return h.toString(16); }

const SETTINGS = "herdr-board.settings";
const NEEDS = "herdr-board.needs";   // how many cards need you: the tab bar's Board button shows it
const DEFAULTS = {
  position: "side",                  // side | top
  click: "session",                  // what clicking a card does: session (open its live session) | card
  compact: true,                     // To do, Ready and Done cards on one line
  showDone: true,
  showArchived: false,               // cleaned cards pile up: off until you want them
  refresh: 5,                        // seconds between reads of the board
  notifyNeeds: true,                 // toast + sound when a card needs you
  notifyDone: false,                 // Herdr already says when an agent finishes
  // boards: [{machine, script, board}]: every board the panel shows at once (machine "" = this computer).
  // Older settings had one connection in machine/script/board; conns() reads those when boards is absent.
  machine: "", script: "", board: "",   // empty until set in ⚙ → Boards
};
// One short line for the header, from whatever the CLI or node printed.
function explain(err, c) {
  if (/Cannot find module/.test(err)) return `No board CLI at ${c.script}. Check ⚙ → Boards.`;
  if (/no board\.json/.test(err)) return `No board.json in ${c.board}. Check ⚙ → Boards.`;
  if (/not recognized|ENOENT|command not found/.test(err)) return "Node isn't installed (or not on the PATH) on that machine.";
  const line = (err || "").split("\n").map((l) => l.trim()).find((l) => l && !/^at |^node:|^\^|^throw/.test(l));
  return (line || "Cannot read the board.").slice(0, 160);
}

function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const f = findNode(child, id); if (f) return f; }
  return null;
}

// Done and Archived can be hidden in the settings
function shown(col) { return col === "done" ? S().showDone : col === "archived" ? S().showArchived : true; }

function S() { return { ...DEFAULTS, ...(shared(SETTINGS) ?? {}) }; }
function setS(patch) { setShared(SETTINGS, { ...(shared(SETTINGS) ?? {}), ...patch }); }
const SLOT_ID = { side: "board-side", top: "board-top" };   // the layout's node ids

function vertical() { const p = props() ?? {}; return p.slot ? p.slot === "side" : S().position === "side"; }

// The connections, one per board: {machine (null = this computer), script, board, off (switched off in the settings)}.
function norm(c) { return { machine: c?.machine || null, script: (c?.script || "").trim(), board: (c?.board || "").trim(), off: c?.enabled === false || c?.off === true }; }
// As saved (duplicates included); conns() is what the panel reads.
function stored() { const s = S(); return Array.isArray(s.boards) && s.boards.length ? s.boards.map(norm) : [norm(s)]; }
function once(list) { return list.filter((c, i) => list.findIndex((o) => connKey(o) === connKey(c)) === i); }   // the same board twice: once
// every board in the settings, switched off ones included (the settings dialog lists them all)
function listed() { return once(stored()); }
function conns() { return once(stored().filter((c) => !c.off)); }   // a switched-off board is kept in the settings but not read or shown
// The panel can't read anything until a board has both its CLI path and its folder.
function configured() { return conns().some((c) => c.script && c.board); }
function allOff() { return stored().length > 0 && stored().every((c) => c.off && c.script && c.board); }
function connKey(c) { return `${c.machine || ""}|${c.script}|${c.board}`; }
function machineName(c) { return c.machine || "This computer"; }
// A card id is unique on its own board only: the same repo on two machines gives two HB-4.
function safeId(s) { return String(s).replace(/[^A-Za-z0-9_-]/g, "-"); }

// Runs the board CLI on the server. Resolves {ok, out, err}.
async function cli(c, args, timeout = 30000) {
  try {
    const r = await exec("node", [c.script, "--board", c.board, ...args], { on: c.machine, timeout });
    return { ok: r.code === 0, out: r.stdout.trim(), err: (r.stderr || r.stdout).trim().replace(/^herdr-board: /, "") };
  } catch (e) {
    return { ok: false, out: "", err: String(e?.message ?? e) };
  }
}

const PRESSED = {};   // button id -> when a press last ran its action

function button(id, text, action, { primary = false, tone = null, tip = null, dim = false } = {}) {
  const t = theme();
  const fg = primary ? t.solid_foreground : tone ?? t.foreground;
  const pressed = PRESSED;   // per button id, so a redraw between press and release does not lose it
  return h_flex().id(id).h(22).px(8).items_center().rounded(6).flex_shrink_0()
    .border_1().border_color(primary ? t.solid : t.border).bg(primary ? t.solid : t.raised)
    .text_size(11).font_medium().text_color(fg).cursor_pointer()
    .when(dim, (el) => el.opacity(0.45))
    .hover((s) => s.opacity(dim ? 0.45 : 0.85))
    .when(Boolean(tip), (el) => el.tooltip(tip))
    // Act on the press, not only on the release: a click that needs the release to land on the same element
    // is lost when the view redraws or the pane is only taking focus, and the button then needs a second click.
    // The click handler stays for keyboard activation, and is skipped when the press already ran the action.
    .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); pressed[id] = Date.now(); action(cx); })
    .on_click((_e, cx) => { cx.stop_propagation(); if (Date.now() - (pressed[id] ?? 0) > 3000) action(cx); })
    .child(text);
}

// A question is one line of text, written like "Which one? Options: (a) X (recommended); (b) Y; (c) Z". Split it into
// the question itself and its options, so the dialog can show them apart. No options found: {stem: q, options: []}.
function parseQuestion(q) {
  const text = String(q ?? "").trim();
  // "Options:" starts the list anywhere; a bare "(a)" / "(1)" only does at the start of a sentence, not inside "Should I use (a) X or (b) Y?"
  const mark = text.match(/\boptions?\s*:|(?:^|(?<=[.?!:]\s))\(\s*(?:a|1)\s*\)/i);
  if (!mark) return { stem: text, options: [] };
  const head = text.slice(0, mark.index).trim();
  const rest = text.slice(mark.index + (/^options?/i.test(mark[0]) ? mark[0].length : 0)).trim();
  let tail = "";
  const options = [];
  // keyed options "(a) X (b) Y": a key counts only when it is the next one in sequence, so "file(s)" or "(see docs)" stay in the text
  const keyRe = /\(\s*([a-z]|\d{1,2})\s*\)/gi;
  const first = rest.match(/^\(\s*([a-z]|\d{1,2})\s*\)/i);
  if (first) {
    const numeric = /\d/.test(first[1]);
    const keyOf = (n) => (numeric ? String(n + 1) : String.fromCharCode(97 + n));
    let at = -1;
    for (let m; (m = keyRe.exec(rest)); ) {
      if (m[1].toLowerCase() !== keyOf(options.length)) continue;
      if (options.length) options[options.length - 1].text = rest.slice(at, m.index);
      options.push({ key: m[1].toLowerCase(), text: "" });
      at = m.index + m[0].length;
    }
    if (options.length) options[options.length - 1].text = rest.slice(at);
  } else {
    // no keys: split on ";" when there is one, else on commas / "or"
    rest.split(rest.includes(";") ? /\s*;\s*/ : /,\s+(?:or\s+)?|\s+or\s+/).forEach((o, i) => options.push({ key: String.fromCharCode(97 + i), text: o }));
  }
  if (options.length < 2) return { stem: text, options: [] };
  const last = options[options.length - 1];
  const cut = last.text.match(/^(.*?[.)])\s+([A-Z][^.?!]*\?)\s*$/s);   // a closing "Which one?" belongs to the question
  if (cut) { last.text = cut[1]; tail = cut[2]; }
  for (const o of options) {
    o.text = o.text.trim().replace(/^[:,;\s]+|[;,\s]+$/g, "").replace(/^or\s+/i, "").replace(/\.$/, "").trim();
    o.recommended = /recommend/i.test(o.text);
    o.text = o.text.replace(/\s*[(\[]\s*(?:my\s+)?recommended\s*[)\]]/i, "").trim();   // the "recommended" tag shows it; the answer sent stays plain
  }
  const good = options.filter((o) => o.text);
  if (good.length < 2) return { stem: text, options: [] };
  return { stem: [head, tail].filter(Boolean).join(" "), options: good };
}

export default class HerdrBoard extends View {
  init(_props, cx) {
    const p = props() ?? {};
    if (p.dialog === "edit") return this.initEditor(cx);
    if (p.dialog === "new" || p.dialog === "card") return this.initNew(cx);
    if (p.dialog === "answer") return this.initAnswer(cx);
    if (p.dialog === "settings") return this.initSettings(cx);
    // One entry per connection, by connKey: {data (last `ls --json`), error, loading, last, seen}.
    // Each board is read on its own, so a slow ssh machine never holds up the local board.
    this.srcs = {};
    this.jobs = [];            // what the buttons are doing now ("Starting…"), several at once
    this.columns = {};         // connKey|id -> column, to notice a card arriving in needs-you
    this.bump = shared(BUMP);
    // One timer: a dialog's change (bump), a settings change, or the refresh interval.
    // Only the copy in the chosen slot reads the boards; it keeps reading while hidden, for the toasts.
    cx.timer.every(700, (cx) => {
      if (!this.active()) return;
      const list = conns();
      const keys = new Set(list.map(connKey));
      const gone = Object.keys(this.srcs).filter((k) => !keys.has(k));   // a removed connection
      for (const k of gone) delete this.srcs[k];
      if (gone.length) { this.countNeeds(); cx.notify(); }   // its cards and the tab bar's count go at once
      const bumped = shared(BUMP) !== this.bump;
      this.bump = shared(BUMP);
      for (const c of list) {
        const src = this.srcs[connKey(c)];
        // a read still running is not re-queued by the interval (a slow ssh board would be read back to back);
        // only a bump (an action finished) asks for another one after it
        if (!src || bumped || (!src.loading && Date.now() - src.last >= S().refresh * 1000)) this.refreshOne(cx, c);
      }
    });
    // Auto-start: every 30 s ask each board to `tick`. The board decides (its autoStart setting and interval,
    // read fresh each time), so only the active copy ticks and a settings change needs no restart.
    cx.timer.every(30000, (cx) => {
      if (!this.active()) return;
      for (const c of conns()) {
        const src = this.srcs[connKey(c)];
        if (!src?.data?.autoStart?.enabled || src.ticking) continue;   // off (or CLI too old to say): no process, no ssh
        src.ticking = true;
        cx.spawn(async (cx) => {
          const r = await cli(c, ["tick"], 180000);
          src.ticking = false;
          const failed = !r.ok ? r.err : /auto-start failed/.test(r.out) ? r.out : "";   // the CLI reports a failed run on stdout
          if (failed && !src.tickFailed) notify({ title: `Auto-start failed${this.boards().length > 1 ? ` on ${machineName(c)}` : ""}`, body: failed.replace(/\s+/g, " ").slice(0, 700), level: "error" });
          src.tickFailed = Boolean(failed);   // once per failing stretch, not every 30 s
          if (r.ok && /started:/.test(r.out)) this.refreshOne(cx, c);
        });
      }
    });
    // keys.json can bind these: "herdr-board.answer" opens the first card that needs you,
    // "herdr-board.jump" opens its live session.
    cx.spawn(async (cx) => {
      for (;;) {
        const cmd = await nextCommand();
        if (!this.active()) continue;
        const all = this.allCards();
        const first = all.find((c) => c.column === "needs-you");
        const ask = all.find((c) => c.column === "needs-you" && c.questions.length && c.status === "needs-you");
        if (cmd === "answer" && ask) this.answer(ask);
        else if (cmd === "jump" && first) this.open(first);
        else if (cmd === "refresh") this.refresh(cx);
        else if (cmd === "settings") this.openSettings();
        cx.notify();
      }
    });
  }

  // ---------- boards ----------

  // The copy in the slot the Position setting picks (a layout without slots: the only copy).
  active() { const slot = (props() ?? {}).slot; return !slot || slot === S().position; }

  // Every connection with what it last read, in the settings' order, each with a label for its cards:
  // the board's name, plus the machine when two boards share a name.
  boards() {
    const list = conns().map((conn, i) => {
      const src = this.srcs[connKey(conn)] ?? {};
      return { conn, i, data: src.data ?? null, error: src.error ?? "", name: src.data?.board || machineName(conn) };
    });
    for (const b of list) {
      const twin = list.some((o) => o !== b && o.name === b.name);
      b.label = twin && b.data?.board ? `${b.name} (${machineName(b.conn)})` : b.name;
    }
    // still the same (two unnamed boards, or same name on one machine): add the board folder
    for (const b of list) {
      if (list.some((o) => o !== b && o.label === b.label)) b.label = `${b.label} · ${b.conn.board.split(/[\\/]/).filter(Boolean).pop() || b.i + 1}`;
    }
    return list;
  }

  // The cards of every board, each knowing its board: conn (where its CLI runs), board (label), key (unique),
  // multi (several boards: the card shows its board's label).
  allCards() {
    const boards = this.boards(), multi = boards.length > 1;
    return boards.flatMap((b) => (b.data?.cards ?? []).map((c) =>
      ({ ...c, clean: b.data.clean ?? {}, conn: b.conn, boardLabel: b.label, multi, key: `${connKey(b.conn)}|${c.id}`, uid: `b${b.i}-${safeId(c.id)}` })));
  }

  refresh(cx) { for (const c of conns()) this.refreshOne(cx, c); }

  refreshOne(cx, conn) {
    if (!conn.script || !conn.board) return;   // not set up yet: nothing to read
    const k = connKey(conn);
    const src = (this.srcs[k] ??= { data: null, error: "", loading: false, last: 0, seen: false });
    if (src.loading) { src.again = true; return; }   // read again once this one ends: it may predate an action
    src.loading = true;
    src.again = false;
    src.last = Date.now();
    cx.spawn(async (cx) => {
      const r = await cli(conn, ["ls", "--json"]);
      src.loading = false;
      if (this.srcs[k] !== src) return;     // the connection was removed meanwhile
      if (src.again) this.refreshOne(cx, conn);
      // a board that fails keeps showing its last cards, with the error in the header
      if (!r.ok) { src.error = explain(r.err, conn); cx.notify(); return; }
      try { src.data = JSON.parse(r.out); src.error = ""; } catch { src.error = "the board answered something that isn't JSON"; }
      this.announce(k);
      this.nameTabs();
      this.countNeeds();
      cx.notify();
    });
  }

  // How many cards need you, for the tab bar's Board button.
  countNeeds() {
    const needs = this.allCards().filter((c) => c.column === "needs-you").length;
    if (shared(NEEDS) !== needs) setShared(NEEDS, needs);
  }

  // A toast and a sound when a card newly needs you or finishes (each can be turned off).
  // Not on a board's first read.
  announce(k) {
    const src = this.srcs[k];
    if (!src.data) return;   // nothing read yet (e.g. not JSON): the next good read is still the first
    const first = !src.seen;
    src.seen = true;
    const s = S();
    for (const c of this.allCards().filter((c) => connKey(c.conn) === k)) {
      const before = this.columns[c.key];
      this.columns[c.key] = c.column;
      if (first || before === c.column) continue;
      const who = c.multi ? `${c.id} (${c.boardLabel})` : c.id;
      if (c.column === "needs-you" && s.notifyNeeds) {
        playSound("blocked");
        notify({ title: `${who} needs you`, body: c.questions.length ? `${c.questions.length} question(s): ${c.questions[0]}` : c.note || c.title, level: "warning" });
      } else if (c.column === "done" && s.notifyDone) {
        playSound("done");
        notify({ title: `${who} done`, body: c.title, level: "success" });
      }
    }
  }

  // Each card's tab is named after the card ("PRT-3 Add a LICENSE"), so the tab bar and the
  // agents list say which topic each session is. Once per tab, so a name you give it stays.
  nameTabs() {
    this.renamed ??= new Set();
    const list = agents();
    for (const c of this.allCards()) {
      if (!c.address) continue;
      const a = list.find((x) => x.address === this.terminal(c));
      if (!a || this.renamed.has(a.tab)) continue;
      this.renamed.add(a.tab);
      const name = `${c.id} ${c.title}`.slice(0, 32);
      if (a.tab_name !== name) run("tab.rename", { id: a.tab, name });
    }
  }

  // The card's agent as Herdr names it: "<machine>/<address>" for another machine.
  terminal(card) { const m = card.conn.machine; return m ? `${m}/${card.address}` : card.address; }

  // A card's command runs on that card's board.
  get busy() { return this.jobs?.join(" · ") ?? ""; }
  job(label) { this.jobs.push(label); return () => { const i = this.jobs.indexOf(label); if (i >= 0) this.jobs.splice(i, 1); }; }

  act(cx, label, args, timeout, conn) {
    const end = this.job(label);
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await cli(conn, args, timeout);
      end();
      if (!r.ok) notify({ title: `${label.replace(/…$/, "")} failed`, body: r.err.replace(/\s+/g, " ").slice(0, 700), level: "error" });
      this.refreshOne(cx, conn);
      cx.notify();
    });
  }

  // Start next: on every board at once; a board that fails says so in its own toast.
  actAll(cx, label, args, timeout) {
    const all = this.boards();
    const list = all.filter((b) => b.data && !b.error);   // a board that can't be read now would only time out
    const skipped = all.filter((b) => !list.includes(b));
    if (skipped.length) notify({ title: `${label.replace(/…$/, "")}: skipped ${skipped.map((b) => b.label).join(", ")}`,
      body: skipped.some((b) => b.error) ? "That board can't be read right now (see the header)." : "That board hasn't been read yet: try again in a moment.", level: "warning" });
    if (!list.length) return;
    const end = this.job(label);
    cx.notify();
    let left = list.length;
    for (const b of list) cx.spawn(async (cx) => {
      const r = await cli(b.conn, args, timeout);
      if (!r.ok) notify({ title: `${label.replace(/…$/, "")} failed${all.length > 1 ? ` on ${b.label}` : ""}`, body: r.err.replace(/\s+/g, " ").slice(0, 700), level: "error" });
      if (--left === 0) end();
      this.refreshOne(cx, b.conn);
      cx.notify();
    });
  }

  open(card) {
    if (card.address) run("agent.focus", { terminal: this.terminal(card) });
  }

  // Dialogs get the card's own connection (machine, script, board) in their props.
  // Clicking a card opens the same form as New card, filled in; its fields are greyed once the card has started.
  edit(card) {
    openOverlay({
      mod: "herdr-board", kind: "dialog", modal: true, width: 640, height: 0.9,
      props: { dialog: "card", ...card.conn, id: card.id, path: card.path, column: card.column },
    });
  }

  answer(card) {
    openOverlay({
      mod: "herdr-board", kind: "dialog", modal: true, width: 720, height: 0.7,
      props: { dialog: "answer", ...card.conn, id: card.id, title: card.title, path: card.path, column: card.column, questions: card.questions, color: card.color },
    });
  }

  newCard() {
    const boards = this.boards().filter((b) => b.data).map((b) => ({ conn: b.conn, label: b.label, repos: b.data.repos ?? {} }));
    openOverlay({ mod: "herdr-board", kind: "dialog", modal: true, width: 640, height: 0.9, props: { dialog: "new", boards } });
  }

  openSettings() {
    // what each board's board.json says, so the dialog shows it at once
    const server = Object.fromEntries(this.boards().filter((b) => b.data)
      .map((b) => [connKey(b.conn), { maxParallel: b.data.maxParallel, autoStart: b.data.autoStart, clean: b.data.clean, name: b.data.board }]));
    openOverlay({ mod: "herdr-board", kind: "dialog", width: 600, height: 0.85, props: { dialog: "settings", server } });
  }

  // What clicking a card does, from the settings; the other action gets a button.
  clickOpens(c) { return S().click === "session" && Boolean(c.address); }

  // What Clean will do on this card's board, from its settings.
  cleanTip(o) {
    const steps = ["stop its agent"];
    if (o.worktree !== false) steps.push("remove its worktree");
    if (o.branch !== false) steps.push("delete its branch");
    if (o.archive !== false) steps.push("archive the card");
    return steps.join(", ").replace(/^./, (x) => x.toUpperCase());
  }

  cardButtons(c, cx) {
    const t = theme();
    const b = [];
    const id = c.id, u = c.uid, on = c.conn;
    if (c.column === "todo") b.push(button(`ap-${u}`, "Approve", (cx) => this.act(cx, `Approving ${id}…`, ["approve", id], undefined, on),
      { tip: "Uses the card's model and effort; for Auto, Haiku picks them now and says why on the card" }));
    if (c.column === "ready") b.push(button(`st-${u}`, "Start", (cx) => this.act(cx, `Starting ${id}…`, ["start", id], 90000, on)));
    if (c.column === "ready") b.push(button(`un-${u}`, "To do", (cx) => this.act(cx, `Moving ${id} back to To do…`, ["unapprove", id], undefined, on), { tone: t.muted, tip: "Not started yet: move it back to To do (not approved)" }));
    if (c.column === "needs-you" && c.questions.length && c.status === "needs-you")
      b.push(button(`an-${u}`, "Answer", () => this.answer(c), { primary: true, tip: "Answer its questions; the agent continues" }));
    if (c.column === "needs-you" && !c.address)
      b.push(button(`rs-${u}`, "Restart", (cx) => this.act(cx, `Starting ${id}…`, ["start", id], 90000, on), { tip: "Start its agent again in the same worktree" }));
    const pr = c.column === "needs-you" ? c.prompt : null;
    if (pr?.failed) {
      // sent but still showing: Retry only looks again, the server never sends the same answer twice
      b.push(button(`pr-${u}`, "Retry", (cx) => this.act(cx, `Checking ${id}…`, ["press", id, ...String(pr.failed.choice).split(" ")], 30000, on),
        { primary: true, tip: "Look at the prompt again (nothing is sent twice)" }));
    } else if (pr?.options?.length) {
      pr.options.forEach((o, i) => b.push(button(`pr-${u}-${i}`, `${o.key}. ${o.label}`.slice(0, 40),
        (cx) => this.act(cx, `Answering ${id}…`, ["press", id, o.key], 30000, on),
        { primary: i === 0, tip: o.description || `Press ${o.key} in its session` })));
    }
    if (c.address && !this.clickOpens(c)) b.push(button(`op-${u}`, "Open", () => this.open(c), { tip: "Open its live session and take over" }));
    if (c.column === "done") b.push(button(`cl-${u}`, "Clean", (cx) => this.act(cx, `Cleaning ${id}…`, ["clean", id], undefined, on), { tone: t.muted, tip: this.cleanTip(c.clean) }));
    if (c.column === "archived") b.push(button(`rm-${u}`, "Resume", (cx) => this.act(cx, `Resuming ${id}…`, ["resume", id], 90000, on),
      { tone: t.muted, tip: c.session ? "Recreate its worktree and continue its conversation" : "No saved session: Resume will say why it cannot" }));
    if (this.clickOpens(c)) b.push(button(`ed-${u}`, "✎", () => this.edit(c), { tone: t.muted, tip: "Open the card" }));
    return b;
  }

  cardView(c, cx) {
    const t = theme();
    const line = (icon, text, color, wrap) => !text ? null :
      h_flex().gap(5).min_w(0).text_size(11.5).text_color(color ?? t.muted)
        .child(div().flex_shrink_0().w(12).child(icon)).child(wrap ? div().min_w(0).flex_1().child(text) : div().min_w(0).truncate().child(text));
    const model = `${c.model || "auto"} · ${c.effort || "auto"}`;
    const rows = [];
    const compact = S().compact && ["todo", "ready", "done", "archived"].includes(c.column);   // one line + buttons
    if (compact) {
      // title and buttons only
    } else if (c.column !== "todo" && c.column !== "ready") {
      rows.push(line("◎", c.where.goal, t.foreground));
      if (c.column !== "done" && c.column !== "archived") rows.push(line("✓", c.where.done));
      rows.push(line("→", c.column === "done" || c.column === "archived" ? "" : c.where.next, t.accent));
    }
    if (c.column === "needs-you") {
      if (c.note) rows.push(line("⚠", c.note, t.blocked));
      if (c.lastMessage) rows.push(line("💬", c.lastMessage, t.muted, true));
      c.questions.forEach((q, i) => rows.push(line("?", `${i + 1}. ${q}`, t.blocked)));
      const pr = c.prompt;
      if (pr) {
        // the prompt text (one row per line, the screen's last lines for a permission prompt), then what to do about it
        String(pr.text || "").split("\n").slice(-8).forEach((l, i) => rows.push(line(i ? "" : "❓", l.trim(), t.foreground)));
        pr.options.filter((o) => o.description).forEach((o) => rows.push(line("", `${o.key}. ${o.label}: ${o.description}`, t.dim)));
        if (pr.failed) rows.push(line("✗", `${pr.failed.choice} was sent but the prompt is still showing`, t.blocked));
        else if (!pr.options.length) rows.push(line("↪", "Too complex to answer here: open its session", t.dim));
      }
    }
    const live = c.agent === "working";
    // Done tag: the Finish-with state reached; "Not reached" when the target was missed; "Blocked" when it cannot continue.
    const out = c.outcome || "reached";
    const tag = c.column !== "done" ? null
      : out === "reached" ? ["✓ " + (REACHED[c.done] || "Done"), REACHED_COLOR[c.done] || TAG_COLOR.done]
      : out === "blocked" ? ["⛔ Blocked", TAG_COLOR.blocked]
      : ["✗ Not reached" + (REACHED[c.done] ? `: ${REACHED[c.done]}` : ""), TAG_COLOR.missed];
    return h_flex().id(`card-${c.uid}`).w_full().rounded(8).overflow_hidden().flex_shrink_0()
      .bg(t.background).border_1().border_color(c.column === "needs-you" ? t.blocked : t.border)
      .cursor_pointer().hover((s) => s.border_color(t.input))
      .tooltip(this.clickOpens(c) ? "Click to open its live session" : "Click to open the card")
      .on_click(() => (this.clickOpens(c) ? this.open(c) : this.edit(c)))
      .child(div().w(4).h_full().flex_shrink_0().bg(c.color))     // the repo's color
      .child(v_flex().flex_1().min_w(0).p(8).gap(3)
        .child(h_flex().gap(6).items_center().min_w(0)
          .child(div().flex_shrink_0().text_size(11).font_semibold().text_color(c.color).child(c.id))
          .child(div().min_w(0).flex_1().truncate().text_size(12.5).font_medium().text_color(t.foreground).child(c.title))
          .when(c.multi, (el) => el.child(div().flex_shrink_0().max_w(110).truncate().px(5).rounded(4).bg(t.raised)
            .text_size(10.5).text_color(t.muted).child(c.boardLabel)))
          .when(Boolean(tag), (el) => el.child(div().min_w(0).max_w(150).truncate().px(5).rounded(4).bg(t.raised)
            .text_size(10.5).font_medium().text_color(tag[1]).child(tag[0])))
          .when(live, (el) => el.child(div().flex_shrink_0().text_size(11).text_color(t.working)
            .frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90))))
        .when(!compact, (el) => el.child(div().text_size(11).text_color(t.dim).truncate().child(`${c.repo} · ${model} · ${c.done}`)))
        .when(!compact && Boolean(c.autoChoice), (el) => el.child(div().text_size(10.5).text_color(t.dim).truncate().child(c.autoChoice)))
        .children(rows.filter(Boolean))
        .child(h_flex().pt(3).gap(5).flex_wrap().children(this.cardButtons(c, cx))));
  }

  render(cx) {
    const p = props() ?? {};
    if (p.dialog === "edit") return this.renderEditor(cx);
    if (p.dialog === "new" || p.dialog === "card") return this.renderNew(cx);
    if (p.dialog === "answer") return this.renderAnswer(cx);
    if (p.dialog === "settings") return this.renderSettings(cx);
    if (!this.active()) return div().size_full().bg(theme().chrome);   // the other slot: hidden anyway
    if (vertical()) return this.renderVertical(cx);
    const t = theme();
    const cards = this.cards();
    const needs = cards.filter((c) => c.column === "needs-you").length;
    const error = this.errorText();
    const header = h_flex().h(38).px(12).gap(8).items_center().flex_shrink_0().border_b(1).border_color(t.border)
      .child(div().text_size(13).font_semibold().text_color(t.foreground).child(this.heading()))
      .child(div().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(this.runningText()))
      .when(needs > 0, (el) => el.child(div().px(7).py(1).rounded_full().bg(t.blocked).text_color(t.solid_foreground)
        .text_size(11).font_semibold().child(`${needs} need${needs > 1 ? "" : "s"} you`)))
      .when(Boolean(this.busy), (el) => el.child(div().text_size(11.5).text_color(t.working).child(this.busy)))
      .when(Boolean(error), (el) => el.child(div().min_w(0).truncate().text_size(11.5).text_color(t.blocked).child(`⚠ ${error}`)))
      .child(div().flex_1())
      .child(button("b-new", "+ New card", () => this.newCard(), { primary: true }))
      .child(button("b-next", "Start next", (cx) => this.actAll(cx, "Starting…", ["next"], 180000), { tip: "Start approved cards while slots are free" }))
      .child(button("b-ref", "↻", (cx) => this.refresh(cx), { tip: "Refresh now" }))
      .child(button("b-set", "⚙", () => this.openSettings(), { tip: "Board settings" }));

    const column = ([key, label]) => {
      const list = cards.filter((c) => c.column === key);
      const alert = key === "needs-you" && list.length > 0;
      return v_flex().id(`col-${key}`).flex_1().min_w(0).h_full().rounded(10).bg(alert ? t.selected : t.surface)
        .child(h_flex().px(10).h(30).gap(6).items_center().flex_shrink_0()
          .child(div().text_size(11.5).font_semibold().text_color(alert ? t.blocked : t.muted).child(label.toUpperCase()))
          .child(div().text_size(11).text_color(t.dim).child(String(list.length))))
        .child(v_flex().id(`colb-${key}`).flex_1().min_h(0).px(6).pb(6).gap(6).overflow_y_scrollbar()
          .children(list.map((c) => this.cardView(c, cx))));
    };

    return v_flex().id("board").size_full().bg(t.chrome).text_color(t.foreground)
      .child(header)
      .child(!configured() ? this.emptyState()
        : h_flex().flex_1().min_h(0).p(8).gap(8).children(COLUMNS.filter(([k]) => shown(k)).map(column)));
  }

  // Shown instead of the columns until a board is set up.
  emptyState() {
    const t = theme();
    return v_flex().id("unconfigured").flex_1().min_h(0).items_center().justify_center().gap(10).p(16)
      .child(div().text_size(12.5).text_color(t.muted).child(allOff() ? "Every board is switched off. Switch one on in ⚙ → Boards" : "Set the machine and the paths in ⚙ → Boards"))
      .child(button("b-conn", "Open settings", () => this.openSettings(), { primary: true }));
  }

  cards() { return this.allCards().filter((c) => shown(c.column)); }

  // Header bits for both layouts: the title, "2/3 running" per board, one error line per board.
  heading() { const b = this.boards(); return b.length === 1 ? b[0].data?.board || "Board" : "Boards"; }
  runningText() {
    const b = this.boards();
    if (b.length === 1) return b[0].data ? `${b[0].data.running}/${b[0].data.maxParallel} running` : configured() ? "loading…" : "";
    return b.map((x) => `${x.label} ${x.data ? `${x.data.running}/${x.data.maxParallel}` : "…"}`).join(" · ");
  }
  errors() {
    const b = this.boards();
    return b.filter((x) => x.error).map((x) => (b.length > 1 ? `${x.label}: ${x.error}` : x.error));
  }
  errorText() { return this.errors().join(" · "); }

  // ---------- vertical panel: sections, most urgent first ----------

  folded() {
    if (!this._folded) {
      try { this._folded = JSON.parse(localStorage.getItem("folded") ?? "null"); } catch { this._folded = null; }
      // defaults first: a folded state saved before Archived existed must not open it
      const saved = this._folded && typeof this._folded === "object" ? this._folded : {};
      this._folded = { done: true, archived: true, ...saved };
    }
    return this._folded;
  }

  toggleFold(key) {
    const f = this.folded();
    f[key] = !f[key];
    try { localStorage.setItem("folded", JSON.stringify(f)); } catch { /* per-viewer nicety only */ }
  }

  renderVertical(cx) {
    const t = theme();
    const cards = this.cards();
    const needs = cards.filter((c) => c.column === "needs-you").length;
    const errors = this.errors();
    const header = v_flex().px(12).py(8).gap(6).flex_shrink_0().border_b(1).border_color(t.border)
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().child(this.heading()))
        .child(button("b-ref", "↻", (cx) => this.refresh(cx), { tip: "Refresh now" }))
        .child(button("b-set", "⚙", () => this.openSettings(), { tip: "Board settings" })))
      .child(h_flex().gap(6).items_center()
        .child(div().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(this.runningText()))
        .when(needs > 0, (el) => el.child(div().px(6).rounded_full().bg(t.blocked).text_color(t.solid_foreground)
          .text_size(10.5).font_semibold().child(`${needs} need${needs > 1 ? "" : "s"} you`)))
        .child(div().flex_1())
        .child(button("b-new", "+", () => this.newCard(), { primary: true, tip: "New card" }))
        .child(button("b-next", "▶", (cx) => this.actAll(cx, "Starting…", ["next"], 180000), { tip: "Start next: approved cards while slots are free" })))
      .when(Boolean(this.busy), (el) => el.child(div().text_size(11.5).text_color(t.working).child(this.busy)))
      .children(errors.map((e) => div().text_size(11.5).text_color(t.blocked).child(`⚠ ${e}`)));

    const order = ["needs-you", "running", "ready", "todo", "done", "archived"].filter(shown);
    const labels = Object.fromEntries(COLUMNS);
    const section = (key) => {
      const list = cards.filter((c) => c.column === key);
      const open = list.length > 0 && !this.folded()[key];
      const alert = key === "needs-you" && list.length > 0;
      return v_flex().gap(6).flex_shrink_0()
        .child(h_flex().id(`sec-${key}`).h(24).gap(6).items_center().cursor_pointer()
          .on_click((_e, cx) => { if (list.length) { this.toggleFold(key); cx.notify(); } })
          .child(div().w(10).text_size(10).text_color(t.dim).child(list.length ? (open ? "▾" : "▸") : ""))
          .child(div().text_size(11.5).font_semibold().text_color(alert ? t.blocked : list.length ? t.muted : t.dim).child(labels[key].toUpperCase()))
          .child(div().text_size(11).text_color(t.dim).child(String(list.length))))
        .when(open, (el) => el.children(list.map((c) => this.cardView(c, cx))));
    };

    return v_flex().id("board").size_full().bg(t.chrome).text_color(t.foreground)
      .child(header)
      .child(!configured() ? this.emptyState() : v_flex().id("sections").flex_1().min_h(0).px(8).py(8).gap(8).overflow_y_scrollbar()
        .children(order.map(section)));
  }

  // ---------- dialog: settings ----------

  // One row per connection: its machine, two path fields, and what its board.json says (agents at once,
  // auto-start, clean). Rows are made here and by "+ Add a connection", never while drawing.
  initSettings(cx) {
    this.msg = "";
    this.serial = 0;
    const server = props().server ?? {};
    this.rows = listed().map((c) => this.makeRow(cx, c, server[connKey(c)]));
  }

  makeRow(cx, c, known) {
    const row = { n: this.serial++, enabled: !c.off, machine: c.machine || "", maxParallel: known?.maxParallel ?? null,
      autoStart: known?.autoStart ?? null, clean: known?.clean ?? null, name: known?.name ?? "" };
    row.script = InputState.new({ value: c.script });
    row.boardDir = InputState.new({ value: c.board });
    // Agents at once: any whole number, typed (Enter or leaving the field) or stepped with - / +
    row.par = InputState.new({ value: row.maxParallel == null ? "" : String(row.maxParallel) });
    const commitPar = (_e, cx) => this.setPar(cx, row, Number(row.par.value().trim()));
    row.par.on("submit", commitPar);
    row.par.on("blur", commitPar);
    // the paths apply like every other setting: shortly after typing stops, and on closing
    const later = (_e, cx) => { this.pending?.cancel(); this.pending = cx.timer.after(800, (cx) => this.saveRows(cx)); };
    row.script.on("change", later);
    row.boardDir.on("change", later);
    if (row.maxParallel == null) { if (row.enabled) this.loadRow(cx, row); }   // a board not read yet (a switched-off one is read when switched on)
    else row.loaded = connKey(this.rowConn(row));
    return row;
  }

  rowConn(row) { return norm({ machine: row.machine, script: row.script.value(), board: row.boardDir.value() }); }
  // what is saved for a row: its connection plus its on/off switch
  rowSaved(row) { return { machine: row.machine, script: row.script.value().trim(), board: row.boardDir.value().trim(), enabled: row.enabled }; }

  // Reads the row's board.json values (after opening, adding, or changing where it points).
  loadRow(cx, row) {
    const conn = this.rowConn(row);
    row.loaded = connKey(conn);
    if (!conn.script || !conn.board) { Object.assign(row, { maxParallel: null, autoStart: null, clean: null, name: "" }); row.par.set_value(""); return; }
    cx.spawn(async (cx) => {
      const r = await cli(conn, ["ls", "--json"]);
      if (connKey(this.rowConn(row)) !== connKey(conn)) return;   // changed meanwhile
      try {
        const d = JSON.parse(r.out);
        Object.assign(row, { maxParallel: d.maxParallel, autoStart: d.autoStart, clean: d.clean ?? null, name: d.board });
        row.par.set_value(d.maxParallel == null ? "" : String(d.maxParallel));
      } catch { Object.assign(row, { maxParallel: null, autoStart: null, clean: null, name: "" }); row.par.set_value(""); }
      cx.notify();
    });
  }

  // Writes every connection; a row that now points somewhere else reads its board again.
  saveRows(cx) {
    const boards = this.rows.map((r) => this.rowSaved(r));
    if (JSON.stringify(boards.map(norm)) === JSON.stringify(stored())) return;   // as saved, duplicates included
    setS({ boards });
    if (cx) for (const r of this.rows) if (r.enabled && r.loaded !== connKey(this.rowConn(r))) this.loadRow(cx, r);
  }

  addRow(cx) {
    const last = this.rows[this.rows.length - 1];
    const used = new Set(this.rows.map((r) => r.machine));
    // another machine Herdr knows, else this computer; the paths start as the last row's
    const machine = machines().map((m) => m.name ?? "").find((m) => !used.has(m)) ?? "";
    this.rows.push(this.makeRow(cx, { machine, script: last?.script.value() ?? "", board: last?.boardDir.value() ?? "" }));
    this.saveRows(cx);
  }

  removeRow(cx, row) {
    if (this.rows.length < 2) return;
    this.rows = this.rows.filter((r) => r !== row);
    this.saveRows(cx);
  }

  closeSettings() { this.pending?.cancel(); this.saveRows(null); closeOverlay(props().overlay); }

  // Moves the board to the other slot; it stays shown or hidden as it was.
  setPosition(pos) {
    const old = S().position;
    if (pos === old) return;
    const shown = !findNode(layout(), SLOT_ID[old])?.hidden;
    setS({ position: pos });
    run("layout.hide", { id: SLOT_ID[old] });
    if (shown) run("layout.show", { id: SLOT_ID[pos] });
  }

  setPar(cx, row, n) {
    if (!Number.isSafeInteger(n) || n < 1) n = row.maxParallel;   // not a number: back to what is saved
    if (n == null) return;
    row.par.set_value(String(n));
    if (n === row.maxParallel) return;
    // taken at once, so a blur right after Enter, or a -/+ click right after typing, build on this value (not the old one)
    const prev = row.maxParallel;
    row.maxParallel = n;
    this.serverSetting(cx, row, "maxParallel", n, prev);
  }

  serverSetting(cx, row, key, value, prev) {
    this.msg = "Saving…";
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await cli(this.rowConn(row), ["config", key, String(value)]);
      // an older herdr-board.mjs does not know the newer settings and answers with its usage line
      if (!r.ok && key === "maxParallel") { row.maxParallel = prev; row.par.set_value(prev == null ? "" : String(prev)); }   // not saved: show what is saved
      this.msg = r.ok ? "" : /usage: config/.test(r.err) ? `Out of date: this board's herdr-board.mjs cannot save "${key}". Run ./deploy.sh again.` : r.err;
      if (r.ok) {
        if (key === "autoStart") row.autoStart = { ...row.autoStart, enabled: value === "on" };
        else if (key === "autoInterval") row.autoStart = { ...row.autoStart, intervalMinutes: value };
        else if (key.startsWith("clean")) row.clean = { worktree: true, branch: true, archive: true, ...row.clean, [key[5].toLowerCase() + key.slice(6)]: value === "on" };
        else row[key] = value;
      }
      setShared(BUMP, Date.now());
      cx.notify();
    });
  }

  renderSettings(cx) {
    const t = theme();
    const p = props();
    const s = S();
    const seg = (id, options, current, pick) => h_flex().gap(4).flex_wrap().children(options.map(([v, label]) =>
      h_flex().id(`${id}-${v}`).h(26).px(10).items_center().rounded(7).cursor_pointer().text_size(12)
        .border_1().border_color(current === v ? t.accent : t.border).bg(current === v ? t.selected : t.raised)
        .text_color(current === v ? t.foreground : t.muted)
        .on_click((_e, cx) => { pick(v, cx); cx.notify(); }).child(label)));
    const onOff = (id, key) => seg(id, [[true, "On"], [false, "Off"]], s[key], (v) => setS({ [key]: v }));
    const row = (label, hint, control) => h_flex().gap(12).items_center().py(6)
      .child(v_flex().w(180).flex_shrink_0()
        .child(div().text_size(12.5).child(label))
        .when(Boolean(hint), (el) => el.child(div().text_size(11).text_color(t.dim).child(hint))))
      .child(div().flex_1().min_w(0).child(control));
    const title = (text) => div().pt(12).pb(2).text_size(11).font_semibold().text_color(t.dim).child(text.toUpperCase());
    const field = (state) => Input.new(state).h(28).px(8).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(12);
    const known = machines().map((m) => m.name ?? "");
    const many = this.rows.length > 1;
    // one block per connection: where its board is, then what its board.json says
    const connection = (r, i) => v_flex().id(`conn-${r.n}`).mt(8).px(12).py(4).rounded(8).border_1().border_color(t.border)
      .child(h_flex().h(30).gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_semibold().text_color(r.enabled ? t.foreground : t.dim)
          .child(r.name ? `${r.name} · ${machineName(this.rowConn(r))}` : `Board ${i + 1} · ${machineName(this.rowConn(r))}`))
        .child(seg(`en-${r.n}`, [[true, "On"], [false, "Off"]], r.enabled, (v, cx) => { r.enabled = v; this.saveRows(cx); }))
        .when(many, (el) => el.child(button(`rm-${r.n}`, "Remove", (cx) => { this.removeRow(cx, r); cx.notify(); }, { tone: t.muted, tip: "Stop showing this board (nothing is deleted)" }))))
      .when(r.enabled && this.rows.findIndex((o) => o.enabled && connKey(this.rowConn(o)) === connKey(this.rowConn(r))) < i,
        (el) => el.child(div().text_size(11.5).text_color(t.blocked).child("Same machine and folder as a board above: shown once.")))
      .child(row("Machine", "Where its repos and agents are",
        seg(`mach-${r.n}`, [...new Set([r.machine, ...known])].map((m) => [m, m || "This computer"]), r.machine,
          (v, cx) => { r.machine = v; this.saveRows(cx); })))
      .child(row("Board CLI", "herdr-board.mjs on that machine", field(r.script)))
      .child(row("Board folder", "Holds board.json and cards/", field(r.boardDir)))
      .child(row("Agents at once", "Saved in its board.json",
        (() => {
          const btn = (id, label, d) => h_flex().id(`${id}-${r.n}`).w(26).h(26).items_center().justify_center().rounded(7).cursor_pointer().text_size(14)
            .border_1().border_color(t.border).bg(t.raised).text_color(t.foreground)
            .on_click((_e, cx) => { if (r.maxParallel != null) this.setPar(cx, r, Math.max(1, r.maxParallel + d)); cx.notify(); }).child(label);
          return h_flex().gap(4).items_center().child(btn("par-dec", "−", -1))
            .child(Input.new(r.par).w(56).h(26).px(8).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(12))
            .child(btn("par-inc", "+", 1));
        })()))
      .child(row("Auto-start", "Start approved cards by itself while slots are free (needs this panel open)",
        seg(`as-${r.n}`, [["on", "On"], ["off", "Off"]], r.autoStart ? (r.autoStart.enabled ? "on" : "off") : null,
          (v, cx) => this.serverSetting(cx, r, "autoStart", v))))
      .child(row("Auto-start every", "Minutes between checks",
        seg(`ai-${r.n}`, [1, 5, 10, 15, 30, 60].map((n) => [n, n === 60 ? "1 h" : `${n} min`]), r.autoStart?.intervalMinutes,
          (v, cx) => this.serverSetting(cx, r, "autoInterval", v))))
      .child(row("Clean button", "What it does to a Done card; the agent is always stopped",
        v_flex().gap(4)
          .child(h_flex().gap(8).items_center().child(div().w(110).text_size(12).child("Remove worktree"))
            .child(seg(`cw-${r.n}`, [["on", "On"], ["off", "Off"]], r.clean ? (r.clean.worktree ? "on" : "off") : null, (v, cx) => this.serverSetting(cx, r, "cleanWorktree", v))))
          .child(h_flex().gap(8).items_center().child(div().w(110).text_size(12).child("Delete branch"))
            .child(seg(`cb-${r.n}`, [["on", "On"], ["off", "Off"]], r.clean ? (r.clean.branch ? "on" : "off") : null, (v, cx) => this.serverSetting(cx, r, "cleanBranch", v))))
          .child(h_flex().gap(8).items_center().child(div().w(110).text_size(12).child("Archive card"))
            .child(seg(`ca-${r.n}`, [["on", "On"], ["off", "Off"]], r.clean ? (r.clean.archive ? "on" : "off") : null, (v, cx) => this.serverSetting(cx, r, "cleanArchive", v))))));

    return v_flex().id("settings").size_full().bg(t.popover).text_color(t.foreground)
      .on_key_down((e, cx) => { if (e.key === "escape") { this.closeSettings(); cx.stop_propagation(); } })
      .child(h_flex().px(18).h(48).flex_shrink_0().items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().text_size(15).font_semibold().child("Board settings"))
        .child(div().text_size(11).text_color(t.dim).child("Changes apply at once")))
      .child(v_flex().id("settings-body").flex_1().min_h(0).px(18).pb(12).overflow_y_scrollbar()
      .child(title("Display"))
      .child(row("Position", "Show or hide it with the Board button in the tab bar",
        seg("pos", [["side", "Beside the sidebar"], ["top", "Across the top"]], s.position, (v) => this.setPosition(v))))
      .child(row("Clicking a card", null, seg("click", [["session", "Opens its live session"], ["card", "Opens the card"]], s.click, (v) => setS({ click: v }))))
      .child(row("Compact cards", "To do, Ready, Done and Archived on one line", onOff("compact", "compact")))
      .child(row("Show Done", null, onOff("done", "showDone")))
      .child(row("Show Archived", "Cleaned cards", onOff("archived", "showArchived")))
      .child(row("Refresh every", null, seg("refresh", [[5, "5 s"], [15, "15 s"], [60, "1 min"]], s.refresh, (v) => setS({ refresh: v }))))
      .child(title("Alerts"))
      .child(row("Card needs you", "Toast with its first question, and a sound", onOff("nn", "notifyNeeds")))
      .child(row("Card done", "Herdr already tells you when an agent finishes", onOff("nd", "notifyDone")))
      .child(title("Boards"))
      .child(div().text_size(11).text_color(t.dim).child("The panel shows the cards of every board here together, e.g. this computer and a machine over ssh."))
      .children(this.rows.map(connection))
      .child(h_flex().pt(8).child(button("s-add", "+ Add a board", (cx) => { this.addRow(cx); cx.notify(); }, { tip: "Another machine (or another board folder) to show alongside" }))))
      .child(h_flex().px(18).h(52).flex_shrink_0().gap(8).items_center().border_t(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(this.msg === "Saving…" ? t.muted : t.blocked).child(this.msg))
        .child(button("s-close", "Done", () => this.closeSettings(), { primary: true })));
  }

  // ---------- dialog: card editor ----------

  initEditor(cx) {
    this.code = null;
    this.msg = "";
    this.handle = cx.focus_handle();
    this.loadCard(cx);
  }

  loadCard(cx) {
    const p = props();
    cx.spawn(async (cx) => {
      const text = await readTextFile(p.path, { on: p.machine }).catch(() => null);
      if (text === null) { this.msg = `Cannot read ${p.path}`; cx.notify(); return; }
      this.opened = text;
      const t = theme();
      if (this.code) this.code.set_value(text);
      else this.code = EditorState.new({
        language: "markdown", value: text, soft_wrap: true, line_numbers: false,
        font_family: settings().font_family, font_size: 13,
        syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 },
      });
      this.msg = "";
      cx.notify();
    });
  }

  save(cx, then) {
    const p = props();
    const text = this.code?.value();
    if (text == null) return;
    this.msg = "Saving…";
    cx.notify();
    cx.spawn(async (cx) => {
      const c = { machine: p.machine, script: p.script, board: p.board };
      let r = { ok: true };
      const enc = encodeURIComponent(text);
      // the text travels as one command-line argument: Windows allows about 32k characters
      if (enc.length > 28000) { this.msg = "This card is too long to save from the panel. Shorten it, or edit the file on the server."; cx.notify(); return; }
      if (text !== this.opened) r = await cli(c, ["save", p.id, enc, textHash(this.opened)]);
      if (r.ok && then) r = await cli(c, then, 60000);
      if (!r.ok) { this.msg = r.err; cx.notify(); return; }
      setShared(BUMP, Date.now());
      closeOverlay(p.overlay);
    });
  }

  renderEditor(cx) {
    const t = theme();
    const p = props();
    const answering = p.column === "needs-you";
    return v_flex().id("editor").track_focus(this.handle).size_full().bg(t.popover).text_color(t.foreground)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(p.overlay); cx.stop_propagation(); } })
      .child(h_flex().px(16).h(46).gap(10).items_center().border_b(1).border_color(t.border)
        .child(div().text_size(14).font_semibold().child(p.id))
        .child(div().text_size(11.5).text_color(t.dim).truncate().child(p.path))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).child("Esc closes without saving")))
      .when(answering, (el) => el.child(div().px(16).py(8).text_size(12).text_color(t.blocked)
        .child("Write your answers under \"## Answers\", then Send answers. The agent continues in its session.")))
      .child(div().flex_1().min_h(0).p(8).child(this.code ? Editor.new(this.code).size_full() : div().p(12).text_color(t.muted).child(this.msg ? "" : "Loading…")))
      .child(h_flex().px(16).h(52).gap(8).items_center().border_t(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(this.msg.startsWith("Saving") ? t.muted : t.blocked).child(this.msg))
        .when(this.msg.includes("changed since"), (el) => el.child(button("e-reload", "Reload", (cx) => this.loadCard(cx))))
        .child(button("e-cancel", "Cancel", () => closeOverlay(p.overlay)))
        .child(button("e-save", "Save", (cx) => this.save(cx), { primary: !answering }))
        .when(answering, (el) => el.child(button("e-send", "Send answers", (cx) => this.save(cx, ["answer", p.id]), { primary: true }))));
  }

  // ---------- dialog: answer questions ----------

  initAnswer(cx) {
    this.msg = "";
    this.picks = {};   // question index -> chosen option
    this.parsed = (props().questions ?? []).map(parseQuestion);
    this.handle = cx.focus_handle();
    this.reply = EditorState.new({ language: "markdown", value: "", soft_wrap: true, line_numbers: false, folding: false,
      font_family: settings().font_family, font_size: 13 });
  }

  send(cx) {
    const p = props();
    const picked = Object.keys(this.picks).map(Number).sort((a, b) => a - b).map((i) => `${i + 1}. ${this.picks[i].text}`);
    const text = [...picked, this.reply.value().trim()].filter(Boolean).join("\n");
    if (!text) { this.msg = "Pick an option or write your answer first."; cx.notify(); return; }
    this.msg = "Sending…";
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await cli({ machine: p.machine, script: p.script, board: p.board }, ["answer", p.id, "--uri", encodeURIComponent(text)], 60000);
      if (!r.ok) { this.msg = r.err; cx.notify(); return; }
      setShared(BUMP, Date.now());
      closeOverlay(p.overlay);
    });
  }

  renderAnswer(cx) {
    const t = theme();
    const p = props();
    const qs = p.questions ?? [];
    return v_flex().id("answer").track_focus(this.handle).size_full().bg(t.popover).text_color(t.foreground)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(p.overlay); cx.stop_propagation(); } })
      .child(h_flex().px(16).h(46).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().text_size(14).font_semibold().text_color(p.color).child(p.id))
        .child(div().flex_1().min_w(0).truncate().text_size(14).font_semibold().child(p.title))
        .child(div().text_size(11).text_color(t.dim).child("Esc closes")))
      .child(v_flex().id("a-questions").px(16).py(12).gap(12).flex_1().min_h(0).overflow_y_scrollbar()
        .children(qs.map((q, i) => {
          const { stem, options } = this.parsed[i] ?? parseQuestion(q);
          const chosen = this.picks[i];
          return v_flex().gap(6)
            .child(h_flex().gap(8).items_start().px(10).py(8).rounded(8).bg(t.raised).border_l(3).border_color(t.blocked)
              .child(div().flex_shrink_0().text_size(14).font_semibold().text_color(t.blocked).child(`${i + 1}.`))
              .child(div().flex_1().min_w(0).text_size(14).font_semibold().child(stem)))
            .children(options.map((o) => {
              const on = chosen?.key === o.key;
              return h_flex().id(`a-opt-${i}-${o.key}`).gap(8).items_start().ml(14).px(10).py(6).rounded(6).cursor_pointer()
                .border_1().border_color(on ? t.solid : t.border).bg(on ? t.solid : t.background)
                .text_color(on ? t.solid_foreground : t.foreground)
                .hover((s) => s.opacity(0.85))
                .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); if (this.picks[i]?.key === o.key) delete this.picks[i]; else this.picks[i] = o; this.msg = ""; cx.notify(); })
                .child(div().flex_shrink_0().w(18).text_size(12).font_semibold().child(o.key.toUpperCase()))
                .child(div().flex_1().min_w(0).text_size(12.5).child(o.text))
                .when(o.recommended, (el) => el.child(div().flex_shrink_0().text_size(10.5).font_medium().opacity(0.8).child("recommended")));
            }));
        })))
      .child(div().px(16).pb(6).text_size(11.5).text_color(t.dim).child("Click an option above, or write your own answer below (\"1. MIT  2. Jane Doe\"). Both are sent."))
      .child(div().h(110).flex_shrink_0().mx(16).rounded(8).border_1().border_color(t.input).bg(t.background).p(6)
        .child(Editor.new(this.reply).size_full()))
      .child(h_flex().px(16).h(52).gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(this.msg === "Sending…" ? t.muted : t.blocked).child(this.msg))
        .child(button("a-edit", "Edit card", () => { closeOverlay(p.overlay); openOverlay({ mod: "herdr-board", kind: "dialog", modal: true, width: 0.7, height: 0.85, props: { ...p, dialog: "edit", overlay: undefined } }); }))
        .child(button("a-cancel", "Cancel", () => closeOverlay(p.overlay)))
        .child(button("a-send", "Send answers", (cx) => this.send(cx), { primary: true })));
  }

  // ---------- dialog: new card ----------

  // props.boards: [{conn, label, repos}]. Picking a repo picks its board: the card is made there.
  initNew(cx) {
    this.existing = props().dialog === "card";   // the form of a card that already exists
    this.locked = false;                         // true once the card has started: shown, not changeable
    this.loaded = !this.existing;
    // With one repo in all, it is picked for you; with several, you must choose (the form says so if you don't).
    const withRepos = (props().boards ?? []).filter((x) => Object.keys(x.repos).length);
    const all = withRepos.flatMap((x) => Object.keys(x.repos));
    this.pick = all.length === 1 ? { b: props().boards.indexOf(withRepos[0]), repo: all[0] } : null;
    this.errs = {};           // mandatory fields found empty on Create: {repo, title}
    this.title = "";
    this.msg = "";
    this.done = "pr-ready";
    this.model = "";          // "" = the default (sonnet / medium)
    this.effort = "";
    this.creating = false;
    this.formBusy = "";
    this.created = "";        // id of a card already made by this form (see create)
    // Plain text areas (same font as the Title field); Tab walks Title -> Context -> Constraints -> Done looks like.
    this.context = TextareaState.new({ value: "" });
    this.constraints = TextareaState.new({ value: "" });
    this.doneLooks = TextareaState.new({ value: "" });
    this.input = InputState.new({ value: "" });
    this.input.on("change", (_e, cx) => { this.title = this.input.value(); if (this.title.trim()) this.errs.title = ""; cx.notify(); });
    this.input.on("submit", (_e, cx) => (this.existing ? this.saveForm(cx) : this.create(cx)));
    this.fields = [this.input, this.context, this.constraints, this.doneLooks];
    if (!globalThis.__hbTabKeys) {
      // Only inside our own dialog: the keymap is the whole app's, so a bare "Input" context would take Tab from every other input.
      try {
        cx.bind_keys([{ keystroke: "tab", action: "new-card-next", context: "NewCard > Input" }, { keystroke: "shift-tab", action: "new-card-prev", context: "NewCard > Input" }]);
        globalThis.__hbTabKeys = true;
      } catch { /* the on_key_down handler below still moves between fields where the text area lets it through */ }
    }
    for (const st of this.fields) st.on("focus", () => { this.focused = st; });
    this.focused = this.input;
    if (this.existing) { this.loadForm(cx); return; }
    this.input.focus();
    cx.timer.after(400, () => { if (this.focused === this.input) this.input.focus(); });
  }

  // An existing card: fill the form from the card file.
  loadForm(cx) {
    const p = props();
    cx.spawn(async (cx) => {
      const r = await cli(p, ["show", p.id]);
      let f = null;
      try { f = JSON.parse(r.out); } catch { /* shown below */ }
      if (!r.ok || !f) { this.msg = r.err || "Cannot read the card."; cx.notify(); return; }
      this.form = f;
      this.title = f.title;
      this.input.set_value(f.title);
      this.context.set_value(f.context);
      this.constraints.set_value(f.constraints);
      this.doneLooks.set_value(f.doneLooks);
      this.done = f.done; this.model = f.model; this.effort = f.effort;
      this.locked = f.status !== "todo";
      this.loaded = true;
      this.msg = "";
      if (!this.locked) this.input.focus();
      cx.notify();
    });
  }

  // Save an existing card's changes (only a card that has not started).
  saveForm(cx) {
    const p = props();
    if (this.creating || !this.loaded || this.locked) return;
    if (!this.title.trim()) { this.errs = { title: "Write a title." }; cx.notify(); return; }
    const fields = encodeURIComponent(JSON.stringify({
      title: this.title.trim(), done: this.done, model: this.model, effort: this.effort,
      context: this.context.value(), constraints: this.constraints.value(), doneLooks: this.doneLooks.value(),
    }));
    if (fields.length > 28000) { this.msg = "The text is too long for the form. Shorten it."; cx.notify(); return; }
    this.creating = true;
    this.msg = "Saving…";
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await cli(p, ["update", p.id, "--hash", this.form.hash, "--fields", fields]);
      if (!r.ok) { this.creating = false; this.formBusy = ""; this.msg = r.err; cx.notify(); return; }
      setShared(BUMP, Date.now());
      closeOverlay(p.overlay);
    });
  }

  // The card as plain text (the Markdown file), for what the form does not show.
  editText() {
    const p = props();
    closeOverlay(p.overlay);
    openOverlay({ mod: "herdr-board", kind: "dialog", modal: true, width: 0.7, height: 0.85, props: { ...p, dialog: "edit", overlay: undefined } });
  }

  // Tab / Shift+Tab: the next / previous text field, in the order they are on the screen.
  // The text areas bind Tab to their own indent action, which runs before any key handler, so Tab is also bound
  // (in initNew, once) to our own actions in the Input context, where a later binding wins.
  tabField(e, cx, back = Boolean(e?.modifiers?.shift)) {
    if (this.locked) { cx.stop_propagation(); return; }   // a started card's fields are not changeable: do not walk into them
    const order = this.fields;
    const at = order.indexOf(this.focused);
    const to = order[(Math.max(at, 0) + (back ? order.length - 1 : 1)) % order.length];
    this.focused = to;
    to.focus();
    cx.stop_propagation();
  }

  // startNow: also start the agent right away, whatever the "Start" choice and the free slots say.
  create(cx, startNow = false) {
    const p = props();
    if (this.creating) return;   // a second click or Enter would create a second card
    this.errs = {
      repo: this.pick ? "" : "Pick a repo.",
      title: this.title.trim() ? "" : "Write a title.",
    };
    if (this.errs.repo || this.errs.title) { this.msg = ""; cx.notify(); return; }
    const fields = encodeURIComponent(JSON.stringify({
      done: this.done, model: this.model, effort: this.effort, approved: startNow,
      context: this.context.value(), constraints: this.constraints.value(), doneLooks: this.doneLooks.value(),
    }));
    if (fields.length > 28000) { this.msg = "The text is too long for the form. Shorten it, or edit the card afterwards."; cx.notify(); return; }
    this.creating = true;
    this.formBusy = startNow ? "start" : "create";
    this.msg = startNow ? "Creating and starting…" : "Creating…";
    cx.notify();
    cx.spawn(async (cx) => {
      const c = p.boards[this.pick.b].conn;
      let id = this.created;   // set when an earlier Create and start made the card but could not start it: retry only the start
      if (!id) {
        const r = await cli(c, ["new", this.pick.repo, this.title.trim(), "--fields", fields]);
        if (!r.ok) { this.creating = false; this.formBusy = ""; this.msg = r.err; cx.notify(); return; }
        id = this.created = String(r.out).trim().split(/\s+/)[0];
      }
      setShared(BUMP, Date.now());   // the card shows up on the board at once
      closeOverlay(p.overlay);       // the start can take a while: do not keep the form open for it
      if (startNow) {
        const s = await cli(c, ["start", id], 90000);
        // an auto-start tick may have started the (approved) card between `new` and `start`: that is a success
        if (!s.ok && !/already running/.test(s.err))
          // the card exists and is approved: it will start when a slot is free, or start it from the board
          notify({ title: `${id} was created but did not start`, body: String(s.err).replace(/\s+/g, " ").slice(0, 700), level: "error" });
        setShared(BUMP, Date.now());
      }
    });
  }

  // "Create with agent": a chat agent asks what is missing and writes the card. The form's text goes with it.
  help(cx) {
    const p = props();
    if (this.creating) return;
    if (!this.pick) { this.errs = { ...this.errs, repo: "Pick a repo." }; this.msg = ""; cx.notify(); return; }
    const fields = encodeURIComponent(JSON.stringify({
      done: this.done, model: this.model, effort: this.effort,
      context: this.context.value(), constraints: this.constraints.value(), doneLooks: this.doneLooks.value(),
    }));
    if (fields.length > 28000) { this.msg = "The text is too long for the form. Shorten it first."; cx.notify(); return; }
    this.creating = true;
    this.formBusy = "help";
    this.msg = "Starting the agent…";
    cx.notify();
    cx.spawn(async (cx) => {
      const c = p.boards[this.pick.b].conn;
      const r = await cli(c, ["draft", this.pick.repo, this.title.trim(), "--fields", fields], 90000);
      if (!r.ok) { this.creating = false; this.formBusy = ""; this.msg = r.err; cx.notify(); return; }
      closeOverlay(p.overlay);
      try { run("agent.focus", { terminal: c.machine ? `${c.machine}/${r.out}` : r.out }); } catch { /* the agent is in Herdr anyway */ }
    });
  }

  // A field of an existing card that has started: dimmed, and clicks do not reach it.
  grey(el) {
    if (!this.locked) return el;
    return div().relative().opacity(0.5).child(el)
      .child(div().absolute().top_0().left_0().size_full().on_mouse_down("left", (_e, cx) => cx.stop_propagation()));
  }

  renderNew(cx) {
    const t = theme();
    const p = props();
    const boards = p.boards ?? [];
    const repoChips = (bd, bi) => h_flex().gap(6).flex_wrap().children(Object.entries(bd.repos).map(([name, color]) => {
      const on = this.pick?.b === bi && this.pick.repo === name;
      return h_flex().id(`repo-${bi}-${safeId(name)}`).h(26).px(10).gap(6).items_center().rounded(7).cursor_pointer()
        .border_1().border_color(on ? color : t.border).bg(on ? t.selected : t.raised)
        .on_click((_e, cx) => { this.pick = { b: bi, repo: name }; this.errs.repo = ""; cx.notify(); })
        .child(div().w(8).h(8).rounded_full().bg(color)).child(div().text_size(12).child(name));
    }));
    const chip = (id, options, current, pick) => h_flex().gap(4).flex_wrap().children(options.map(([v, label, color]) =>
      h_flex().id(`${id}-${v}`).h(26).px(10).gap(6).items_center().rounded(7).cursor_pointer().text_size(12)
        .border_1().border_color(current === v ? (color ?? t.accent) : t.border).bg(current === v ? t.selected : t.raised)
        .text_color(current === v ? t.foreground : t.muted)
        .on_click((_e, cx) => { pick(v); cx.notify(); })
        .when(Boolean(color), (el) => el.child(div().w(8).h(8).rounded_full().bg(color)))
        .child(label)));
    const label = (text, hint) => h_flex().gap(8).items_center().pt(8)
      .child(div().text_size(11.5).font_semibold().text_color(t.muted).child(text))
      .when(Boolean(hint), (el) => el.child(div().text_size(11).text_color(t.dim).child(hint)));
    const err = (text) => div().text_size(11.5).text_color(t.blocked).child(`⚠ ${text}`);
    const area = (state, h) => this.grey(Textarea.new(state).h(h).flex_shrink_0().px(10).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(12.8));
    return v_flex().id("new").size_full().bg(t.popover).text_color(t.foreground)
      .key_context("NewCard")
      .on_action("new-card-next", (_e, cx) => this.tabField(null, cx, false))
      .on_action("new-card-prev", (_e, cx) => this.tabField(null, cx, true))
      .on_key_down((e, cx) => {
        if (e.key === "escape") { closeOverlay(p.overlay); cx.stop_propagation(); }
        else if (e.key === "tab") this.tabField(e, cx);
      })
      .child(h_flex().px(18).h(48).flex_shrink_0().items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().text_size(15).font_semibold().child(this.existing ? p.id : "New card"))
        .child(div().text_size(11).text_color(t.dim).child(this.existing ? (this.locked ? "Started: read only. Esc closes" : "Esc closes without saving") : "Esc closes without creating")))
      .child(v_flex().id("new-body").flex_1().min_h(0).px(18).pb(12).gap(4).overflow_y_scrollbar()
        .when(this.existing && this.locked, (el) => el.child(div().pt(8).text_size(12).text_color(t.dim)
          .child("This card has started, so its fields can no longer be changed here. Use Edit as text to add to the card file.")))
        .when(this.existing && !this.loaded, (el) => el.child(div().pt(8).text_size(12).text_color(t.muted).child(this.msg || "Loading…")))
        .when(this.existing, (el) => el.child(label("Repo")).child(div().text_size(12).text_color(t.muted).child(this.form?.repo ?? "")))
        .when(!this.existing, (el) => el.child(label("Repo")))
        // with several boards, their repos are grouped under each board's name
        .children(this.existing ? [] : boards.length > 1
          ? boards.map((bd, bi) => v_flex().gap(4).child(div().text_size(11).font_semibold().text_color(t.muted).child(bd.label)).child(repoChips(bd, bi)))
          : boards.map(repoChips))
        .when(!this.existing && !boards.length, (el) => el.child(div().text_size(12).text_color(t.blocked).child("No board could be read yet. Check ⚙ → Boards.")))
        .when(Boolean(this.errs.repo), (el) => el.child(err(this.errs.repo)))
        .child(label("Title"))
        .child(this.grey(Input.new(this.input).h(34).px(10).rounded(8).border_1().border_color(this.errs.title ? t.blocked : t.input).bg(t.background).text_size(12.8)))
        .when(Boolean(this.errs.title), (el) => el.child(err(this.errs.title)))
        .child(label("Context", "Why it matters, what you know, links, files to look at"))
        .child(area(this.context, 110))
        .child(label("Constraints", "What the agent must not do or change"))
        .child(area(this.constraints, 70))
        .child(label("Done looks like", "What you will check to call it done"))
        .child(area(this.doneLooks, 70))
        .child(label("Finish with", "How far the agent takes it"))
        .child(this.grey(chip("done", FINISH_WITH,
          this.done, (v) => { this.done = v; })))
        .child(label("Model", "Auto: Haiku picks on approve"))
        .child(this.grey(chip("model", [["", "Auto"], ["haiku", "Haiku"], ["sonnet", "Sonnet"], ["opus", "Opus"]], this.model, (v) => { this.model = v; })))
        .child(label("Effort", "Auto: Haiku picks on approve"))
        .child(this.grey(chip("effort", [["", "Auto"], ["low", "Low"], ["medium", "Medium"], ["high", "High"], ["xhigh", "Extra high"]], this.effort, (v) => { this.effort = v; }))))
      .child(h_flex().px(18).h(52).flex_shrink_0().gap(8).items_center().border_t(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(this.creating ? t.muted : t.blocked).child(this.msg))
        .child(button("n-cancel", this.existing && this.locked ? "Close" : "Cancel", () => closeOverlay(p.overlay)))
        .when(this.existing, (el) => el.child(button("n-text", "Edit as text", () => this.editText(), { tip: "Open the card's Markdown file" }))
          .when(!this.locked && this.loaded, (e2) => e2.child(button("n-save", "Save", (cx) => this.saveForm(cx), { primary: true }))))
        .when(!this.existing, (el) => el.child(button("n-help", this.formBusy === "help" ? "Starting…" : "Create with agent", (cx) => this.help(cx), { tip: "A chat agent asks what is missing and fills the empty fields", dim: this.creating && this.formBusy !== "help" }))
          .child(button("n-create", this.formBusy === "create" ? "Creating…" : "Create card", (cx) => this.create(cx), { primary: true, dim: this.creating && this.formBusy !== "create" }))
          .child(button("n-start", this.formBusy === "start" ? "Creating and starting…" : "Create and start", (cx) => this.create(cx, true), { dim: this.creating && this.formBusy !== "start", primary: true, tip: "Create the card and start its agent right away. Create card leaves it in To do until you approve it" }))));
  }
}
