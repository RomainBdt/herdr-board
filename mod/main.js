// herdr-board panel: the board's cards in five columns, read from the server's herdr-board CLI.
// The same mod also draws its dialogs (card editor, new card) when opened as an overlay.
// Layout props: { machine: "server", script: "C:/.../herdr-board.mjs", board: "C:/.../board" }
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, EditorState, Editor } from "gpui-base";
import { exec, run, props, theme, settings, notify, playSound, openOverlay, closeOverlay, readTextFile, shared, setShared, agents, nextCommand } from "herdr";

const COLUMNS = [
  ["todo", "To do"], ["ready", "Ready"], ["running", "Running"], ["needs-you", "Needs you"], ["done", "Done"],
];
const BUMP = "herdr-board.bump";     // dialogs set it after a change so the board refreshes at once

// same as textHash in herdr-board.mjs: the editor sends it back so a card an agent changed isn't overwritten
function textHash(t) { let h = 5381; for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0; return h.toString(16); }

function cfg() { const p = props() ?? {}; return { machine: p.machine ?? null, script: p.script, board: p.board }; }

// Runs the board CLI on the server. Resolves {ok, out, err}.
async function cli(c, args, timeout = 30000) {
  try {
    const r = await exec("node", [c.script, "--board", c.board, ...args], { on: c.machine, timeout });
    return { ok: r.code === 0, out: r.stdout.trim(), err: (r.stderr || r.stdout).trim().replace(/^herdr-board: /, "") };
  } catch (e) {
    return { ok: false, out: "", err: String(e?.message ?? e) };
  }
}

function button(id, text, action, { primary = false, tone = null, tip = null } = {}) {
  const t = theme();
  const fg = primary ? t.solid_foreground : tone ?? t.foreground;
  return h_flex().id(id).h(22).px(8).items_center().rounded(6).flex_shrink_0()
    .border_1().border_color(primary ? t.solid : t.border).bg(primary ? t.solid : t.raised)
    .text_size(11).font_medium().text_color(fg).cursor_pointer()
    .hover((s) => s.opacity(0.85))
    .when(Boolean(tip), (el) => el.tooltip(tip))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
    .child(text);
}

export default class HerdrBoard extends View {
  init(_props, cx) {
    const p = props() ?? {};
    if (p.dialog === "edit") return this.initEditor(cx);
    if (p.dialog === "new") return this.initNew(cx);
    if (p.dialog === "answer") return this.initAnswer(cx);
    this.data = null;          // last `ls --json`
    this.error = "";
    this.busy = "";            // what a button is doing now ("Planning…")
    this.columns = {};         // id -> column, to notice a card arriving in needs-you
    this.bump = shared(BUMP);
    this.refresh(cx);
    cx.timer.every(5000, (cx) => this.refresh(cx));
    cx.timer.every(700, (cx) => { if (shared(BUMP) !== this.bump) { this.bump = shared(BUMP); this.refresh(cx); } });
    // keys.json can bind these: "herdr-board.answer" opens the first card that needs you,
    // "herdr-board.jump" opens its live session.
    cx.spawn(async (cx) => {
      for (;;) {
        const cmd = await nextCommand();
        const first = (this.data?.cards ?? []).find((c) => c.column === "needs-you");
        const ask = (this.data?.cards ?? []).find((c) => c.column === "needs-you" && c.questions.length && c.status === "needs-you");
        if (cmd === "answer" && ask) this.answer(ask);
        else if (cmd === "jump" && first) this.open(first);
        else if (cmd === "refresh") this.refresh(cx);
        cx.notify();
      }
    });
  }

  // ---------- board ----------

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      const r = await cli(cfg(), ["ls", "--json"]);
      this.loading = false;
      if (!r.ok) { this.error = r.err || "cannot read the board"; cx.notify(); return; }
      try { this.data = JSON.parse(r.out); this.error = ""; } catch { this.error = "the board answered something that isn't JSON"; }
      this.announce();
      this.nameTabs();
      cx.notify();
    });
  }

  // A toast and a sound when a card newly needs you or finishes. Not on the first read.
  announce() {
    const first = Object.keys(this.columns).length === 0;
    for (const c of this.data?.cards ?? []) {
      const before = this.columns[c.id];
      this.columns[c.id] = c.column;
      if (first || before === c.column) continue;
      if (c.column === "needs-you") {
        playSound("blocked");
        notify({ title: `${c.id} needs you`, body: c.questions.length ? `${c.questions.length} question(s): ${c.questions[0]}` : c.note || c.title, level: "warning" });
      } else if (c.column === "done") {
        playSound("done");
        notify({ title: `${c.id} done`, body: c.title, level: "success" });
      }
    }
  }

  // Each card's tab is named after the card ("PRT-3 Add a LICENSE"), so the tab bar and the
  // agents list say which topic each session is. Once per tab, so a name you give it stays.
  nameTabs() {
    this.renamed ??= new Set();
    const m = cfg().machine;
    const list = agents();
    for (const c of this.data?.cards ?? []) {
      if (!c.address) continue;
      const a = list.find((x) => x.address === (m ? `${m}/${c.address}` : c.address));
      if (!a || this.renamed.has(a.tab)) continue;
      this.renamed.add(a.tab);
      const name = `${c.id} ${c.title}`.slice(0, 32);
      if (a.tab_name !== name) run("tab.rename", { id: a.tab, name });
    }
  }

  act(cx, label, args, timeout) {
    this.busy = label;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await cli(cfg(), args, timeout);
      this.busy = "";
      if (!r.ok) notify({ title: `${label.replace(/…$/, "")} failed`, body: r.err.slice(0, 300), level: "error" });
      this.refresh(cx);
      cx.notify();
    });
  }

  open(card) {
    const m = cfg().machine;
    if (card.address) run("agent.focus", { terminal: m ? `${m}/${card.address}` : card.address });
  }

  edit(card) {
    const c = cfg();
    openOverlay({
      mod: "herdr-board", kind: "dialog", modal: true, width: 0.7, height: 0.85,
      props: { dialog: "edit", ...c, id: card.id, path: card.path, column: card.column },
    });
  }

  answer(card) {
    openOverlay({
      mod: "herdr-board", kind: "dialog", modal: true, width: 720, height: 0.7,
      props: { dialog: "answer", ...cfg(), id: card.id, title: card.title, path: card.path, column: card.column, questions: card.questions, color: card.color },
    });
  }

  newCard() {
    openOverlay({ mod: "herdr-board", kind: "dialog", width: 460, props: { dialog: "new", ...cfg(), repos: this.data?.repos ?? {} } });
  }

  cardButtons(c, cx) {
    const t = theme();
    const b = [];
    const id = c.id;
    if (c.column === "todo") b.push(button(`ap-${id}`, c.proposed || c.model ? "Approve" : "Approve (sonnet)", (cx) => this.act(cx, `Approving ${id}…`, ["approve", id]),
      { tip: c.proposed ? `${c.proposed.model} / ${c.proposed.effort}: ${c.proposed.note}` : "No plan yet: uses the card's model, else sonnet / medium" }));
    if (c.column === "ready") b.push(button(`st-${id}`, "Start", (cx) => this.act(cx, `Starting ${id}…`, ["start", id], 90000)));
    if (c.column === "needs-you" && c.questions.length && c.status === "needs-you")
      b.push(button(`an-${id}`, "Answer", () => this.answer(c), { primary: true, tip: "Answer its questions; the agent continues" }));
    if (c.column === "needs-you" && !c.address)
      b.push(button(`rs-${id}`, "Restart", (cx) => this.act(cx, `Starting ${id}…`, ["start", id], 90000), { tip: "Start its agent again in the same worktree" }));
    if (c.address) b.push(button(`op-${id}`, "Open", () => this.open(c), { tip: "Open its live session and take over" }));
    if (c.column === "done") b.push(button(`cl-${id}`, "Clean", (cx) => this.act(cx, `Cleaning ${id}…`, ["clean", id]), { tone: t.muted, tip: "Stop its agent and remove its worktree (the branch stays)" }));
    return b;
  }

  cardView(c, cx) {
    const t = theme();
    const line = (icon, text, color) => !text ? null :
      h_flex().gap(5).min_w(0).text_size(11.5).text_color(color ?? t.muted)
        .child(div().flex_shrink_0().w(12).child(icon)).child(div().min_w(0).truncate().child(text));
    const model = c.model ? `${c.model} · ${c.effort}` : c.proposed ? `proposed ${c.proposed.model} · ${c.proposed.effort}` : "not planned";
    const rows = [];
    if (c.column === "todo" || c.column === "ready") {
      if (c.proposed?.note) rows.push(line("💡", `#${c.proposed.order} ${c.proposed.note}`, t.dim));
    } else {
      rows.push(line("◎", c.where.goal, t.foreground));
      if (c.column !== "done") rows.push(line("✓", c.where.done));
      rows.push(line("→", c.column === "done" ? "" : c.where.next, t.accent));
    }
    if (c.column === "needs-you") {
      if (c.note) rows.push(line("⚠", c.note, t.blocked));
      c.questions.forEach((q, i) => rows.push(line("?", `${i + 1}. ${q}`, t.blocked)));
    }
    const live = c.agent === "working";
    return h_flex().id(`card-${c.id}`).w_full().rounded(8).overflow_hidden().flex_shrink_0()
      .bg(t.background).border_1().border_color(c.column === "needs-you" ? t.blocked : t.border)
      .cursor_pointer().hover((s) => s.border_color(t.input))
      .tooltip("Click to open the card")
      .on_click(() => this.edit(c))
      .child(div().w(4).h_full().flex_shrink_0().bg(c.color))     // the repo's color
      .child(v_flex().flex_1().min_w(0).p(8).gap(3)
        .child(h_flex().gap(6).items_center().min_w(0)
          .child(div().flex_shrink_0().text_size(11).font_semibold().text_color(c.color).child(c.id))
          .child(div().min_w(0).flex_1().truncate().text_size(12.5).font_medium().text_color(t.foreground).child(c.title))
          .when(live, (el) => el.child(div().flex_shrink_0().text_size(11).text_color(t.working)
            .frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90))))
        .child(div().text_size(11).text_color(t.dim).truncate().child(`${c.repo} · ${model} · ${c.done}`))
        .children(rows.filter(Boolean))
        .child(h_flex().pt(3).gap(5).flex_wrap().children(this.cardButtons(c, cx))));
  }

  render(cx) {
    const p = props() ?? {};
    if (p.dialog === "edit") return this.renderEditor(cx);
    if (p.dialog === "new") return this.renderNew(cx);
    if (p.dialog === "answer") return this.renderAnswer(cx);
    const t = theme();
    const d = this.data;
    const cards = d?.cards ?? [];
    const needs = cards.filter((c) => c.column === "needs-you").length;
    const header = h_flex().h(38).px(12).gap(8).items_center().flex_shrink_0().border_b(1).border_color(t.border)
      .child(div().text_size(13).font_semibold().text_color(t.foreground).child(d?.board || "Board"))
      .child(div().text_size(11.5).text_color(t.muted).child(d ? `${d.running}/${d.maxParallel} running` : "loading…"))
      .when(needs > 0, (el) => el.child(div().px(7).py(1).rounded_full().bg(t.blocked).text_color(t.solid_foreground)
        .text_size(11).font_semibold().child(`${needs} need${needs > 1 ? "" : "s"} you`)))
      .when(Boolean(this.busy), (el) => el.child(div().text_size(11.5).text_color(t.working).child(this.busy)))
      .when(Boolean(this.error), (el) => el.child(div().min_w(0).truncate().text_size(11.5).text_color(t.blocked).child(`⚠ ${this.error}`)))
      .child(div().flex_1())
      .child(button("b-new", "+ New card", () => this.newCard(), { primary: true }))
      .child(button("b-plan", "Plan", (cx) => this.act(cx, "Planning…", ["plan"], 300000), { tip: "A planner proposes model, effort and order for waiting cards" }))
      .child(button("b-next", "Start next", (cx) => this.act(cx, "Starting…", ["next"], 180000), { tip: "Start approved cards while slots are free" }))
      .child(button("b-ref", "↻", (cx) => this.refresh(cx), { tip: "Refresh now" }));

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
      .child(h_flex().flex_1().min_h(0).p(8).gap(8).children(COLUMNS.map(column)));
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
      .child(div().flex_1().min_h(0).p(8).child(this.code ? Editor.new(this.code).size_full() : div().p(12).text_color(t.muted).child(this.msg || "Loading…")))
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
    this.handle = cx.focus_handle();
    this.reply = EditorState.new({ language: "markdown", value: "", soft_wrap: true, line_numbers: false, folding: false,
      font_family: settings().font_family, font_size: 13 });
  }

  send(cx) {
    const p = props();
    const text = this.reply.value().trim();
    if (!text) { this.msg = "Write your answers first."; cx.notify(); return; }
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
      .child(v_flex().px(16).py(12).gap(8).flex_shrink_0()
        .children(qs.map((q, i) => h_flex().gap(8).items_start()
          .child(div().flex_shrink_0().text_size(12.5).font_semibold().text_color(t.blocked).child(`${i + 1}.`))
          .child(div().flex_1().min_w(0).text_size(12.5).child(q)))))
      .child(div().px(16).pb(6).text_size(11.5).text_color(t.dim).child("Your answers (one line per question is fine: \"1. MIT  2. Jane Doe\")"))
      .child(div().flex_1().min_h(0).mx(16).rounded(8).border_1().border_color(t.input).bg(t.background).p(6)
        .child(Editor.new(this.reply).size_full()))
      .child(h_flex().px(16).h(52).gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(this.msg === "Sending…" ? t.muted : t.blocked).child(this.msg))
        .child(button("a-edit", "Edit card", () => { closeOverlay(p.overlay); openOverlay({ mod: "herdr-board", kind: "dialog", modal: true, width: 0.7, height: 0.85, props: { ...p, dialog: "edit", overlay: undefined } }); }))
        .child(button("a-cancel", "Cancel", () => closeOverlay(p.overlay)))
        .child(button("a-send", "Send answers", (cx) => this.send(cx), { primary: true })));
  }

  // ---------- dialog: new card ----------

  initNew(cx) {
    const repos = Object.keys(props().repos ?? {});
    this.repo = repos[0] ?? "";
    this.title = "";
    this.msg = "";
    this.input = InputState.new({ value: "" });
    this.input.on("change", (_e, cx) => { this.title = this.input.value(); cx.notify(); });
    this.input.on("submit", (_e, cx) => this.create(cx));
    this.input.focus();
    cx.timer.after(400, () => this.input.focus());
  }

  create(cx) {
    const p = props();
    if (!this.repo || !this.title.trim()) { this.msg = "Pick a repo and write a title."; cx.notify(); return; }
    cx.spawn(async (cx) => {
      const c = { machine: p.machine, script: p.script, board: p.board };
      const r = await cli(c, ["new", this.repo, this.title.trim()]);
      if (!r.ok) { this.msg = r.err; cx.notify(); return; }
      const [id, path] = r.out.split(/\s+/);
      setShared(BUMP, Date.now());
      closeOverlay(p.overlay);
      openOverlay({ mod: "herdr-board", kind: "dialog", modal: true, width: 0.7, height: 0.85,
        props: { dialog: "edit", ...c, id, path, column: "todo" } });
    });
  }

  renderNew(cx) {
    const t = theme();
    const p = props();
    const repos = Object.entries(p.repos ?? {});
    return v_flex().id("new").w_full().p(18).gap(10).bg(t.popover).text_color(t.foreground)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(p.overlay); cx.stop_propagation(); } })
      .child(div().text_size(15).font_semibold().child("New card"))
      .child(div().text_size(11.5).text_color(t.dim).child("Repo"))
      .child(h_flex().gap(6).flex_wrap().children(repos.map(([name, color]) =>
        h_flex().id(`repo-${name}`).h(26).px(10).gap(6).items_center().rounded(7).cursor_pointer()
          .border_1().border_color(this.repo === name ? color : t.border).bg(this.repo === name ? t.selected : t.raised)
          .on_click((_e, cx) => { this.repo = name; cx.notify(); })
          .child(div().w(8).h(8).rounded_full().bg(color)).child(div().text_size(12).child(name)))))
      .child(div().text_size(11.5).text_color(t.dim).child("Title"))
      .child(Input.new(this.input).h(34).px(10).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(12.8))
      .child(div().text_size(11.5).text_color(this.msg ? t.blocked : t.dim)
        .child(this.msg || "Next you fill in context, constraints and what done looks like."))
      .child(h_flex().pt(6).gap(8).justify_end()
        .child(button("n-cancel", "Cancel", () => closeOverlay(p.overlay)))
        .child(button("n-create", "Create and edit", (cx) => this.create(cx), { primary: true })));
  }
}
