#!/usr/bin/env node
// herdr-board: a kanban of Claude Code agents. Cards are Markdown files; each running card is a named
// hc terminal in its own git worktree. Runs on the machine that holds the repos (the "server").
// No packages: Node's standard library only.
//
//   you:    new <repo> "<title>" [--fields <enc> | --fields-file <json>] | draft <repo> ["<title>"] [--fields <enc>] | approve <id> [--model m] [--effort e] [--start] | unapprove <id> | next | start <id>
//           add-repo <name> <path> [--prefix P] [--base B] [--color #hex] | remove-repo <name> | suggest-repos <folder>...
//           press <id> <key>... | show <id> | update <id> --hash <h> --fields <enc> | answer <id> ["<text>"] | ls [--json] | clean <id> | resume <id> | tick | config <key> <value>
//   setup:  init <folder> [--name N] [--worktrees D]   (a new board: needs no board.json) | version   (this copy's id; `ls --json` shows it too)
//   agent:  where <id> "<goal>" "<done>" "<next>" | ask <id> "<q1>" ["<q2>" ...] | done <id> [--state <s>] [--pr <url>] "<summary>"
//   hook:   ship-mark <id>   (run by the card's Claude Code hooks, event JSON on stdin: shows or hides the "shipping" label)
//
// The board folder comes from --board <dir>, else HERDR_BOARD, else the folder of this script's parent "board".

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, renameSync, rmdirSync, unlinkSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATUSES = ['todo', 'ready', 'running', 'needs-you', 'done', 'archived'];
const CLEAN_KEYS = { worktree: 'cleanWorktree', branch: 'cleanBranch', archive: 'cleanArchive' };   // what Clean does, each on/off
const MODELS = ['haiku', 'sonnet', 'opus'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// ---------- small helpers ----------

class BoardError extends Error {}
function die(msg) { throw new BoardError(msg); }   // caught in main: message + exit 1
function now() {   // local time, "2026-11-14 10:04"
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16).replace('T', ' ');
}
function slash(p) { return p.replace(/\\/g, '/'); }
function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function takeFlag(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

// A flag with no value: true (and removed) when present.
function takeSwitch(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}

function writeAtomic(path, text) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
}

// ---------- board ----------

// board.json "autoStart": {"enabled": false, "intervalMinutes": 5}; anything unusable falls back to 5.
function autoInterval(v) { const n = Number(v); return Number.isFinite(n) && n >= 1 && n <= 1440 ? n : 5; }

function loadBoard(dir) {
  const file = join(dir, 'board.json');
  if (!existsSync(file)) die(`no board.json in ${dir} (use --board <dir> or HERDR_BOARD)`);
  const b = JSON.parse(readFileSync(file, 'utf8'));
  b.dir = dir;
  b.cardsDir = join(dir, 'cards');
  b.maxParallel ??= 2;
  b.repos ??= {};
  b.autoStart = { enabled: b.autoStart?.enabled === true, intervalMinutes: autoInterval(b.autoStart?.intervalMinutes) };
  b.clean = { worktree: true, branch: true, archive: true, ...(b.clean || {}) };
  if (!b.worktrees) die('board.json needs "worktrees": the folder where card worktrees go');
  return b;
}

function hcEnv(board) {
  const env = { ...process.env };
  if (board.hcSession) env.HC_SESSION = board.hcSession;
  return env;
}

function hc(board, args, { json = true, allowFail = false } = {}) {
  // --json right after the subcommand: anything after "--" belongs to the program hc starts
  const hcArgs = json ? [args[0], '--json', ...args.slice(1)] : args;
  // tests point HERDR_BOARD_HC_SCRIPT at a fake hc (a node script), so no real Herdr session is touched
  const r = process.env.HERDR_BOARD_HC_SCRIPT ? spawnSync(process.execPath, [process.env.HERDR_BOARD_HC_SCRIPT, ...hcArgs], { env: hcEnv(board), encoding: 'utf8' })
    : spawnSync('hc', hcArgs, { env: hcEnv(board), encoding: 'utf8' });
  if (r.status !== 0 && !allowFail) die(`hc ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').trim()}`);
  if (!json) return r.stdout;
  try { return JSON.parse(r.stdout); } catch { return allowFail ? null : die(`hc ${args[0]}: not JSON: ${r.stdout}`); }
}

// ---------- cards: "---" key: value "---" then "## Section" blocks ----------

function parseCard(text) {
  const m = text.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error('card has no --- front matter ---');
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][\w-]*):(.*)$/);
    // "  # hint" is a comment; "Fix #12" is not
    if (kv) meta[kv[1]] = kv[2].replace(/(^|\s)#\s.*$/, '').trim().replace(/^["'](.*)["']$/, '$1');
  }
  const sections = [];          // [{title, body}] in order; text before the first ## kept as title ''
  let cur = { title: '', body: [] };
  for (const line of m[2].split('\n')) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) { sections.push(cur); cur = { title: h[1], body: [] }; } else cur.body.push(line);
  }
  sections.push(cur);
  for (const s of sections) s.body = s.body.join('\n').trim();
  return { meta, sections };
}

function renderCard({ meta, sections }) {
  const head = Object.entries(meta).map(([k, v]) => `${k}: ${v}`).join('\n');
  const body = sections
    .filter(s => s.title || s.body)
    .map(s => (s.title ? `## ${s.title}\n\n${s.body}`.trimEnd() : s.body))
    .join('\n\n');
  return `---\n${head}\n---\n\n${body}\n`;
}

function section(card, title) { return card.sections.find(s => s.title.toLowerCase() === title.toLowerCase()); }
function setSection(card, title, body) {
  const s = section(card, title);
  if (s) s.body = body; else card.sections.push({ title, body });
}

function cardPath(board, id) { return join(board.cardsDir, `${id}.md`); }

function loadCard(board, id) {
  id = id.toUpperCase();
  const path = cardPath(board, id);
  if (!existsSync(path)) die(`no card ${id} (${path})`);
  const card = parseCard(readFileSync(path, 'utf8'));
  card.id = id;
  card.path = path;
  return card;
}

// "Next action": what is left for the person, from the card's status and done target. Rewritten on every save,
// so it is always current; it sits right after the front matter so it is the first thing seen on opening a card.
function nextActionOf(card) {
  const status = card.meta.status || 'todo';
  const target = (card.meta.done || '').split('#')[0].trim();
  const id = card.id;
  if (status === 'todo') return card.meta.approved === 'true' ? 'Nothing: waiting for a free slot to start.' : `**You:** approve the card (\`approve ${id}\`) so the agent can start.`;
  if (status === 'ready') return 'Nothing: approved, waiting for a free slot to start.';
  if (status === 'running') return 'Nothing: the agent is working.';
  if (status === 'needs-you') {
    return questionsOf(card).length
      ? `**You:** answer the questions below, then run \`answer ${id}\`.`
      : '**You:** the agent stopped without asking or finishing. Check its session, or run `start` again.';
  }
  if (status === 'done') {
    switch (target) {
      case 'none': return '**You:** check the Result against "Done looks like". No git changes to review.';
      case 'local': return `**You:** the change is committed on branch \`${card.meta.branch || 'card/' + id}\`. Review it and merge or push it yourself.`;
      case 'local-reviewed': return `**You:** committed and self-reviewed on branch \`${card.meta.branch || 'card/' + id}\`. Review it, then merge or push it yourself.`;
      case 'draft-pr': return '**You:** review the draft pull request (link in Result), mark it ready and merge it.';
      case 'pr-ready': return '**You:** review the pull request (link in Result) and merge it.';
      case 'merged': return 'Nothing: the pull request is merged. Check the Result.';
      default: return `**You:** check the Result against the target: ${target || 'see Context'}.`;
    }
  }
  return '';
}

function saveCard(card) {
  const body = nextActionOf(card);
  if (body) {
    setSection(card, 'Next action', body);
    // keep it first: right after the untitled part before the first "##"
    const i = card.sections.findIndex(s => s.title === 'Next action');
    const [s] = card.sections.splice(i, 1);
    const first = card.sections.findIndex(x => x.title);
    card.sections.splice(first < 0 ? card.sections.length : first, 0, s);
  }
  writeAtomic(card.path, renderCard(card));
}

function allCards(board) {
  if (!existsSync(board.cardsDir)) return [];
  return readdirSync(board.cardsDir)
    .filter(f => f.endsWith('.md'))
    .map(f => {
      try { return loadCard(board, f.slice(0, -3)); } catch (e) { console.error(`skip ${f}: ${e.message}`); return null; }
    })
    .filter(Boolean);
}

function termName(id) { return id.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 32); }

// "Where we are": three lines, goal / done / next
function whereOf(card) {
  const out = { goal: '', done: '', next: '' };
  for (const line of (section(card, 'Where we are')?.body || '').split('\n')) {
    const m = line.match(/^\s*[-*]?\s*\**(goal|done|next)\**\s*:\s*(.*)$/i);
    if (m) out[m[1].toLowerCase()] = m[2].trim();
  }
  return out;
}

const ANSWERS_HINT = (id) => `_Write your answers here, then run \`answer ${id}\`._`;

// The answers you wrote: the section without its italic hint and timestamp lines.
function answersOf(card) {
  return (section(card, 'Answers')?.body || '')
    .split('\n').filter(l => !/^\s*_.*_\s*$/.test(l)).join('\n').trim();
}

function questionsOf(card) {
  return (section(card, 'Questions')?.body || '')
    .split('\n').map(l => l.match(/^\s*\d+[.)]\s+(.*)$/)?.[1]).filter(Boolean);
}

// ---------- live state from hc ----------

function liveTerminals(board) {
  const r = hc(board, ['ls'], { allowFail: true });
  const map = {};
  for (const t of r?.terminals || []) if (t.name) map[t.name] = t;
  return map;
}

// The agent's last words, for a card whose agent stopped without ask/done. Read from the end of the newest Claude
// session transcript of its worktree (~/.claude/projects/<path, non-alphanumerics as ->/*.jsonl), else from the
// bottom of its terminal. Only called for stopped cards, and only the file's tail is read. '' when nothing is found.
const LAST_MSG_CHARS = 300;
function clip(text) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (t.length <= LAST_MSG_CHARS) return t;
  // keep the END: that is where a question or an error sits. Don't start on half a surrogate pair.
  let tail = t.slice(-(LAST_MSG_CHARS - 1));
  if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1);
  return '…' + tail.trimStart();
}
// ls runs often: the answer is kept per card in <board>/.last-message and reused while the transcript is unchanged.
function lastMessageFromTranscript(worktree, cacheFile) {
  const dir = claudeProjectDir(worktree);
  let newest = null;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl') || f.startsWith('agent-')) continue;
    const st = statSync(join(dir, f));
    if (!newest || st.mtimeMs > newest.mtime) newest = { path: join(dir, f), mtime: st.mtimeMs, size: st.size };
  }
  if (!newest) return '';
  const key = `${newest.path}|${newest.mtime}|${newest.size}`;
  if (cacheFile) { try { const c = JSON.parse(readFileSync(cacheFile, 'utf8')); if (c.key === key) return c.text; } catch { /* no cache yet */ } }
  const text = tailMessage(newest);
  if (cacheFile) { try { mkdirSync(dirname(cacheFile), { recursive: true }); writeAtomic(cacheFile, JSON.stringify({ key, text })); } catch { /* cache is optional */ } }
  return text;
}
function tailMessage(newest) {
  // read the tail, growing it until an assistant text turns up (a long tool result can fill the first chunk)
  const fd = openSync(newest.path, 'r');
  try {
    for (let len = 64 * 1024; ; len *= 4) {
      const n = Math.min(len, newest.size);
      const buf = Buffer.alloc(n);
      readSync(fd, buf, 0, n, newest.size - n);
      const lines = buf.toString('utf8').split('\n');
      if (n < newest.size) lines.shift();   // first line is probably cut
      for (let i = lines.length - 1; i >= 0; i--) {
        let o; try { o = JSON.parse(lines[i]); } catch { continue; }
        if (o.type !== 'assistant' || !Array.isArray(o.message?.content)) continue;
        const text = o.message.content.filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
        if (text) return clip(text);
      }
      if (n >= newest.size || len >= 16 * 1024 * 1024) return '';
    }
  } finally { closeSync(fd); }
}
function lastMessageOf(board, card) {
  try {
    if (card.meta.worktree && existsSync(card.meta.worktree)) { const m = lastMessageFromTranscript(card.meta.worktree, join(board.dir, '.last-message', `${card.id}.json`)); if (m) return m; }
  } catch { /* no transcript here (e.g. remote machine): try the terminal */ }
  const screen = hc(board, ['read', termName(card.id)], { json: false, allowFail: true }) || '';
  const lines = screen.split(/\r?\n/).map(l => l.trim()).filter(l => l && !/^[─━═\s>❯│╭╰╮╯]*$/.test(l) && !/\? for shortcuts|shift\+tab|esc to interrupt|auto mode|accept edits/i.test(l));
  return clip(lines.slice(-6).join(' '));
}

// What the board should show, from the card's status and its agent's live state.
function display(card, live, board) {
  const status = card.meta.status || 'todo';
  if (card.meta.start_error && status !== 'running') return { column: 'needs-you', note: `could not start: ${card.meta.start_error}` };
  if (status !== 'running') return { column: status, note: '' };
  const t = live[termName(card.id)];
  if (!t) return { column: 'needs-you', note: 'agent stopped (no terminal)' };
  if (t.status === 'blocked') return { column: 'needs-you', note: 'waiting on a prompt in its session' };
  if (t.status === 'error') return { column: 'needs-you', note: 'agent reported an error' };
  // just started or just answered: an agent reads as idle for a moment before its turn begins
  const fresh = Date.now() - Number(card.meta.active_ms || 0) < 90000;
  if (!fresh && (t.status === 'done' || t.status === 'idle')) return { column: 'needs-you', note: 'agent stopped without asking or finishing', last: lastMessageOf(board, card) };
  return { column: 'running', note: '' };
}

// ---------- Claude's own prompts (AskUserQuestion, permission) ----------

const PRESS_WATCH_MS = 8000;

function promptStateFile(board, id) { return join(board.dir, '.prompt-state', `${id}.json`); }
function readPromptState(board, id) { try { return JSON.parse(readFileSync(promptStateFile(board, id), 'utf8')); } catch { return null; } }
function clearPromptState(board, id) { try { unlinkSync(promptStateFile(board, id)); } catch {} }
function writePromptState(board, id, st) {
  mkdirSync(join(board.dir, '.prompt-state'), { recursive: true });
  writeFileSync(promptStateFile(board, id), JSON.stringify(st));
}

// "❯ 1. Yes" / "  2. No, and tell Claude..." lines on a terminal screen -> [{key, label}]
function screenOptions(screen) {
  const out = [];
  for (const line of String(screen || '').split('\n')) {
    const m = line.match(/^\s*(?:[❯>›]\s*)?(\d{1,2})\.\s+(\S.*?)\s*$/);
    if (m && m[1] === '1') out.length = 0;   // a new list starts: keep the last one (the dialog is at the bottom)
    if (m && Number(m[1]) === out.length + 1) out.push({ key: m[1], label: m[2], description: '' });
  }
  return out;
}

// The last AskUserQuestion call in the session transcript that has no result yet, else null.
// The transcript is ~/.claude/projects/<cwd, every non-alphanumeric char as ->/*.jsonl on the machine running the agent.
function pendingAsk(cwd) {
  try {
    const dir = claudeProjectDir(cwd);
    const files = readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    if (!files.length) return null;
    const file = join(dir, files[0].f);
    const size = statSync(file).size, len = Math.min(size, 400000);   // the tail only: ls is polled
    const fd = openSync(file, 'r'), buf = Buffer.alloc(len);
    try { readSync(fd, buf, 0, len, size - len); } finally { closeSync(fd); }
    const open = new Map();   // tool_use id -> input
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.includes('AskUserQuestion') && !line.includes('tool_result')) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      for (const part of Array.isArray(o.message?.content) ? o.message.content : []) {
        if (part.type === 'tool_use' && part.name === 'AskUserQuestion') open.set(part.id, part.input);
        else if (part.type === 'tool_result') open.delete(part.tool_use_id);
      }
    }
    const last = [...open.values()].pop();
    return Array.isArray(last?.questions) && last.questions.length ? last.questions : null;
  } catch { return null; }
}

// What a blocked card is waiting on: {kind, text, options:[{key,label,description}], multi, screen, failed}.
// options is empty when the panel can't answer it (a multi-question form): the person opens the session.
function promptOf(board, card) {
  const name = termName(card.id);
  const screen = (hc(board, ['read', name], { json: false, allowFail: true }) || '').split('\n').map(l => l.trimEnd()).filter(l => l.trim());
  const body = screen.filter(l => /[A-Za-z0-9]/.test(l) && !/^[─╌]/.test(l));   // drop the ──── and ╌╌╌╌ rules
  const tail = body.slice(-9).join('\n');
  const onScreen = screenOptions(tail);
  let p = { kind: 'screen', text: tail, options: onScreen, multi: false };
  let qs = pendingAsk(card.meta.worktree);
  // a question left unanswered by an old, interrupted run is not what is on screen now
  if (qs && !body.join('\n').includes(String(qs[0].question || '').slice(0, 30))) qs = null;
  if (qs) {
    const q = qs[0];
    const single = qs.length === 1 && !q.multiSelect && onScreen.length >= (q.options || []).length && (q.options || []).length > 0;
    p = {
      kind: 'ask', text: qs.map(x => x.question).join('\n'), multi: qs.length > 1 || Boolean(q.multiSelect),
      options: single ? q.options.map((o, i) => ({ key: String(i + 1), label: o.label, description: o.description || '' })) : [],
    };
  }
  const st = readPromptState(board, card.id);
  const sig = p.options.map(o => o.label).join('|') + '#' + (p.kind === 'ask' ? p.text.slice(0, 80) : (p.text.split('\n').find(l => /\?\s*$/.test(l)) || '').trim());
  p.sig = sig;
  if (st && st.sent && !st.done && st.sig === sig) p.failed = { choice: st.choice, sent: st.sent };   // answered, yet the dialog is still up
  return p;
}

function cmdPress(board, [id, ...keys]) {
  if (!id || !keys.length) die('usage: press <id> <key>...');
  const card = loadCard(board, id);
  const name = termName(id);
  const live = liveTerminals(board);
  if (!live[name] || live[name].status !== 'blocked') die(`${id}: no prompt is waiting`);
  const p = promptOf(board, card);
  const choice = keys.join(' ');
  const st = readPromptState(board, id);
  const same = st && !st.done && st.sig === p.sig;
  const watch = () => {
    for (let t = 0; t < PRESS_WATCH_MS; t += 500) {
      sleepMs(500);
      const l = liveTerminals(board)[name];
      if (!l || l.status !== 'blocked') return true;
      const sc = hc(board, ['read', name], { json: false, allowFail: true }) || '';
      if (!screenOptions(sc.split('\n').filter(x => x.trim()).slice(-15).join('\n')).length) return true;
    }
    return false;
  };
  if (same && st.sent) {
    // never send twice: Retry only looks again
    if (watch()) { writePromptState(board, id, { ...st, done: true }); console.log(`${id}: delivered`); return; }
    die(`${id}: ${st.choice} was sent but the prompt is still showing; not sent again. Open the session`);
  }
  writePromptState(board, id, { sig: p.sig, choice, sent: false, at: Date.now() });
  const r = spawnSync('hc', ['keys', name, ...keys], { env: hcEnv(board), encoding: 'utf8' });
  if (r.status !== 0) die(`could not send the keys: ${(r.stderr || r.stdout || '').trim()}`);   // not sent: Retry may send
  writePromptState(board, id, { sig: p.sig, choice, sent: true, at: Date.now() });
  // a number only moves the highlight in some dialogs: press Enter once if the cursor sits on our choice
  sleepMs(700);
  const sc = hc(board, ['read', name], { json: false, allowFail: true }) || '';
  // only while the same prompt is still up: otherwise Enter would accept the default of the NEXT prompt, unseen
  const sameScreen = sc.includes((p.text.split('\n')[0] || '').trim());
  if (sameScreen && keys.length === 1 && /^\d+$/.test(keys[0]) && new RegExp(`^\\s*[❯>›]\\s*${keys[0]}\\.`, 'm').test(sc)) hc(board, ['keys', name, 'enter'], { json: false, allowFail: true });
  if (watch()) { writePromptState(board, id, { sig: p.sig, choice, sent: true, done: true, at: Date.now() }); console.log(`${id}: delivered`); return; }
  die(`${id}: sent ${choice} but the prompt is still showing. Retry checks again without sending twice`);
}

// ---------- commands ----------

// Fills the template from the panel's form. Empty fields keep the template's defaults.
function applyFields(tpl, f) {
  const clean = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim();
  let out = tpl;
  const front = (key, val) => {
    if (val) out = out.replace(new RegExp(`^${key}:[^\\n]*`, 'm'), () => `${key}: ${val}`);
  };
  front('done', clean(f.done));
  front('model', clean(f.model));
  front('effort', clean(f.effort));
  if (f.approved) front('approved', 'true');
  const section = (name, text) => {
    const body = String(text ?? '').trim();
    if (!body) return;
    out = out.replace(new RegExp(`(## ${name}\\n\\n)[\\s\\S]*?(\\n\\n## )`), (_m, a, b) => a + body + b);
  };
  section('Context', f.context);
  section('Constraints', f.constraints);
  section('Done looks like', f.doneLooks);
  return out;
}

function cmdNew(board, args) {
  let fields = takeFlag(args, '--fields');   // encodeURIComponent(JSON) from the panel's form
  const file = takeFlag(args, '--fields-file');   // or a JSON file (what the card-drafting agent writes)
  if (file) { try { fields = encodeURIComponent(readFileSync(file, 'utf8')); } catch { die(`cannot read ${file}`); } }
  const [repo, ...titleWords] = args;
  const title = titleWords.join(' ').trim();
  if (!repo || !title) die('usage: new <repo> "<title>"');
  const r = board.repos[repo];
  if (!r) die(`unknown repo "${repo}"; board.json knows: ${Object.keys(board.repos).join(', ')}`);
  const prefix = (r.prefix || repo).toUpperCase();
  mkdirSync(board.cardsDir, { recursive: true });
  const nums = readdirSync(board.cardsDir)
    .map(f => f.match(new RegExp(`^${prefix}-(\\d+)\\.md$`))?.[1]).filter(Boolean).map(Number);
  const id = `${prefix}-${nums.length ? Math.max(...nums) + 1 : 1}`;
  const tpl = readFileSync(join(HERE, 'card-template.md'), 'utf8')
    .replaceAll('{{id}}', id).replaceAll('{{repo}}', repo).replaceAll('{{title}}', title)
    .replaceAll('{{created}}', now());
  const path = cardPath(board, id);
  let text = tpl;
  if (fields) {
    let f;
    try { f = JSON.parse(decodeURIComponent(fields)); } catch { die('--fields is not valid encoded JSON'); }
    if (f.model && !MODELS.includes(f.model)) die(`model must be one of ${MODELS.join(', ')}`);
    if (f.effort && !EFFORTS.includes(f.effort)) die(`effort must be one of ${EFFORTS.join(', ')}`);
    if (file) f.approved = false;   // the person approves: an agent's file never starts a card by itself
    text = applyFields(tpl, f);
  }
  writeAtomic(path, text);
  console.log(`${id}  ${slash(path)}`);
}

// A Done card goes back to Running when a new turn starts in its agent session: its terminal is seen busy twice,
// REOPEN_BUSY_MS apart (filters a one-poll blip), and never during the grace period that covers the agent's own
// closing turn after `done`. A reopened card remembers its outcome (`reopened_outcome`)
// and returns to Done by itself once its terminal is idle again, so it never sits in Running after the agent is finished.
const DONE_GRACE_MS = 60000;
const REOPEN_BUSY_MS = 5000;
function reopenDone(board, live) {
  for (const c of allCards(board)) {
    const t = live[termName(c.id)];
    const busy = !!t && !['done', 'idle', 'blocked', 'error'].includes(t.status);
    if (c.meta.status === 'running' && c.meta.reopened_outcome) {
      // a reopened card whose agent went quiet again: back to Done with its earlier outcome
      if (!t || busy || t.status === 'blocked' || t.status === 'error') continue;
      if (Date.now() - Number(c.meta.active_ms || 0) < 90000) continue;
      const card = loadCard(board, c.id);
      if (card.meta.status !== 'running' || !card.meta.reopened_outcome) continue;
      card.meta.status = 'done';
      card.meta.outcome = card.meta.reopened_outcome;
      delete card.meta.reopened_outcome;
      card.meta.done_ms = String(Date.now());
      const w = whereOf(card);
      setSection(card, 'Where we are', `- Goal: ${w.goal}
- Done: ${w.done}
- Next: nothing, card done (see Result)`);
      card.meta.updated = now();
      saveCard(card);
      continue;
    }
    if (c.meta.status !== 'done') continue;
    if (!busy || Date.now() - Number(c.meta.done_ms || 0) < DONE_GRACE_MS) {
      if (c.meta.busy_ms) { const card = loadCard(board, c.id); delete card.meta.busy_ms; saveCard(card); }
      continue;
    }
    if (!c.meta.busy_ms) { const card = loadCard(board, c.id); if (card.meta.status === 'done') { card.meta.busy_ms = String(Date.now()); saveCard(card); } continue; }
    if (Date.now() - Number(c.meta.busy_ms) < REOPEN_BUSY_MS) continue;
    const card = loadCard(board, c.id);
    // re-check on the fresh file: the agent may have run `done` since the board was listed
    if (card.meta.status !== 'done' || Date.now() - Number(card.meta.done_ms || 0) < DONE_GRACE_MS) continue;
    card.meta.reopened_outcome = card.meta.outcome || 'reached';
    card.meta.status = 'running';
    delete card.meta.outcome;
    delete card.meta.done_ms;
    delete card.meta.busy_ms;
    setSection(card, 'Where we are', `- Goal: ${whereOf(card).goal}
- Done: see Result
- Next: working on new work after the card was done`);
    card.meta.active_ms = String(Date.now());
    card.meta.updated = now();
    saveCard(card);
  }
}

// Archived cards: newest close date first (the card's `updated`, which Clean sets), then by done_ms.
// Cards with no `updated` come after the dated ones. Other cards keep their place (stable, in place).
function sortArchived(cards) {
  const key = c => [c.meta.updated || '', Number(c.meta.done_ms) || 0];
  const slots = [], archived = [];
  cards.forEach((c, i) => { if (c.meta.status === 'archived') { slots.push(i); archived.push(c); } });
  archived.sort((a, b) => {
    const [ua, da] = key(a), [ub, db] = key(b);
    if (!ua !== !ub) return ua ? -1 : 1;
    return ua !== ub ? (ua < ub ? 1 : -1) : db - da;
  });
  slots.forEach((i, n) => { cards[i] = archived[n]; });
}

function cmdLs(board, args) {
  const live = liveTerminals(board);
  reopenDone(board, live);
  const all = allCards(board);
  sortArchived(all);
  const cards = all.map(c => {
    const d = display(c, live, board);
    const repo = board.repos[c.meta.repo] || {};
    if (!d.note.startsWith('waiting on a prompt') && live[termName(c.id)]?.status !== 'blocked') clearPromptState(board, c.id);   // that prompt is gone: its "already sent" must not block the next one
    return {
      id: c.id, title: c.meta.title || '', repo: c.meta.repo || '', color: repo.color || '#888888',
      status: c.meta.status || 'todo', column: d.column, note: d.note, lastMessage: d.last || '',
      done: c.meta.done || '', outcome: ['done', 'archived'].includes(c.meta.status) ? (c.meta.outcome || 'reached') : '', session: c.meta.session || '', model: c.meta.model || '', effort: c.meta.effort || '', autoChoice: c.meta.auto_choice || '',
      approved: c.meta.approved === 'true', shipping: d.column === 'running' && isShipping(board, c),
      where: whereOf(c), questions: questionsOf(c),
      prompt: d.note.startsWith('waiting on a prompt') && args.includes('--json') ? promptOf(board, c) : null,
      terminal: live[termName(c.id)] ? termName(c.id) : '',
      address: live[termName(c.id)]?.address || '',
      agent: live[termName(c.id)]?.status || '',
      path: slash(c.path),
    };
  });
  const running = cards.filter(c => c.column === 'running').length;   // same rule as the queue's free slots
  if (args.includes('--json')) {
    const repos = Object.fromEntries(Object.entries(board.repos).map(([k, r]) => [k, r.color || '#888888']));
    console.log(JSON.stringify({ board: board.name || '', maxParallel: board.maxParallel, autoStart: board.autoStart, clean: board.clean, running, repos, cards, cli: cliVersion() }, null, 2));
    return;
  }
  console.log(`${board.name || 'board'}: ${running}/${board.maxParallel} running`);
  for (const col of STATUSES) {
    const list = cards.filter(c => c.column === col);
    if (!list.length) continue;
    console.log(`\n${col.toUpperCase()} (${list.length})`);
    for (const c of list) {
      const mod = c.model || c.effort ? `${c.model || 'sonnet'}/${c.effort || 'medium'}` : '';
      console.log(`  ${c.id.padEnd(9)} ${c.title}  [${c.repo}${mod ? ' · ' + mod : ''}]${c.note ? '  ⚠ ' + c.note : ''}`);
      if (c.lastMessage) console.log(`            “${c.lastMessage}”`);
      if (c.where.next) console.log(`            → ${c.where.next}`);
      for (const q of c.questions) if (c.column === 'needs-you') console.log(`            ? ${q}`);
    }
  }
}

// A late command from an agent must not revive a cleaned card.
function loadLive(board, id) {
  const card = loadCard(board, id);
  if (card.meta.status === 'archived') die(`${card.id} is archived: nothing to change`);
  return card;
}

function cmdWhere(board, [id, goal, done, next]) {
  if (!id || next === undefined) die('usage: where <id> "<goal>" "<done>" "<next>"');
  const card = loadLive(board, id);
  setSection(card, 'Where we are', `- Goal: ${goal}\n- Done: ${done}\n- Next: ${next}`);
  card.meta.updated = now();
  saveCard(card);
  console.log(`${card.id}: updated "Where we are"`);
}

// ---------- the "shipping" label ----------
// While the agent runs /ship, the card shows a "shipping" label. /ship itself is not changed: the card's worktree gets Claude Code
// hooks (see allowShipCommands) that run `ship-mark` when the Skill tool starts /ship (or the person types /ship) and when the
// agent stops (Stop, SessionEnd). The flag is a small file in the board folder, never the card, so it cannot race with the agent's
// own card updates. `done`, `ask` and `clean` clear it too, and `ls` ignores one that is old or whose card is no longer running.
const SHIPPING_MAX_MS = 3 * 3600 * 1000;
function shippingFile(board, id) { return join(board.dir, '.shipping', `${id}.txt`); }
function setShipping(board, id) {
  mkdirSync(join(board.dir, '.shipping'), { recursive: true });
  writeFileSync(shippingFile(board, id), String(Date.now()));
}
function clearShipping(board, id) { try { unlinkSync(shippingFile(board, id)); } catch { /* not shipping */ } }
function isShipping(board, card) {
  if (card.meta.status !== 'running') return false;
  try { return Date.now() - Number(readFileSync(shippingFile(board, card.id), 'utf8')) < SHIPPING_MAX_MS; } catch { return false; }
}

// What a hook event means for the label: 'start' (/ship begins), 'stop' (the agent stopped or the session ended), else null.
function shipEventOf(ev) {
  const name = ev?.hook_event_name;
  if (name === 'PreToolUse') return ev.tool_name === 'Skill' && /^([\w-]+:)?ship$/.test(String(ev.tool_input?.skill || '').trim()) ? 'start' : null;
  if (name === 'UserPromptSubmit') return /^\s*\/([\w-]+:)?ship(\s|$)/.test(String(ev.prompt || '')) ? 'start' : null;
  if (name === 'Stop' || name === 'SessionEnd') return 'stop';
  return null;
}

// Never fails and prints nothing: a hook must not get in the agent's way.
function cmdShipMark(board, [id]) {
  try {
    let ev = {};
    try { ev = JSON.parse(readFileSync(0, 'utf8')); } catch { /* no event: nothing to do */ }
    id = String(id || '').toUpperCase();
    const what = shipEventOf(ev);
    if (!id || !what || !existsSync(cardPath(board, id))) return;
    if (what === 'start') setShipping(board, id); else clearShipping(board, id);
  } catch { /* swallow */ }
}

function cmdAsk(board, [id, ...qs]) {
  if (!id || !qs.length) die('usage: ask <id> "<question 1>" ["<question 2>" ...]');
  const card = loadLive(board, id);
  // an earlier round of questions and answers moves to History, so the card shows only the open ones
  const oldQ = section(card, 'Questions')?.body || '';
  if (oldQ.trim()) {
    const oldA = answersOf(card) || '(no answers)';
    const hist = section(card, 'History')?.body || '';
    setSection(card, 'History', `${hist}\n\n${oldQ}\n\nAnswers: ${oldA}`.trim());
  }
  setSection(card, 'Questions', `_Asked ${now()}_\n\n` + qs.map((q, i) => `${i + 1}. ${q}`).join('\n'));
  setSection(card, 'Answers', ANSWERS_HINT(card.id));
  delete card.meta.reopened_outcome;   // the card is a live question again: it must not slide back to Done by itself
  clearShipping(board, card.id);
  card.meta.status = 'needs-you';
  card.meta.updated = now();
  saveCard(card);
  console.log(`${card.id}: ${qs.length} question(s) on the card. Stop here and wait: the answers will be sent to this session.`);
  startNext(board, { quiet: true });
}

function cmdAnswer(board, args) {
  const uri = takeFlag(args, '--uri');            // the panel sends multi-line text encoded
  let [id, ...text] = args;
  if (uri !== undefined) text = [decodeURIComponent(uri)];
  if (!id) die('usage: answer <id> ["<answer text>"]   (or write them in the card under ## Answers first)');
  const card = loadLive(board, id);
  if (text.length) {
    const prev = answersOf(card);
    setSection(card, 'Answers', `${prev}\n\n_${now()}_\n${text.join(' ')}`.trim());
  }
  const answers = answersOf(card);
  if (!answers) die(`${card.id}: no answers yet. Write them under "## Answers" in ${slash(card.path)} or pass them as text.`);
  card.meta.status = 'running';
  card.meta.active_ms = String(Date.now());
  card.meta.updated = now();
  saveCard(card);
  const name = termName(card.id);
  const live = liveTerminals(board)[name];
  if (!live) die(`${card.id}: answers saved, but its agent (${name}) is not running. Use "start ${card.id}" to start it again.`);
  hc(board, ['send', name, `Your answers are in the card ${slash(card.path)} under "## Answers". Read them and continue.`], { json: false });
  console.log(`${card.id}: answers sent to ${name}`);
}

// What state a finished card reached. Shown as a tag on the card.
const OUTCOMES = ['reached', 'partial', 'blocked', 'failed', 'abandoned'];

function cmdDone(board, args) {
  const given = args.includes('--state');
  const flag = takeFlag(args, '--state');
  if (given && !flag) die(`--state needs a value: ${OUTCOMES.join(', ')}`);
  const state = flag || 'reached';
  const givenPr = args.includes('--pr');
  const pr = takeFlag(args, '--pr');
  if (givenPr && !pr) die('--pr needs the pull request link');
  const [id, ...summary] = args;
  if (!id || !summary.length) die(`usage: done <id> [--state ${OUTCOMES.join('|')}] [--pr <url>] "<summary>"`);
  if (!OUTCOMES.includes(state)) die(`--state must be one of ${OUTCOMES.join(', ')}`);
  const card = loadLive(board, id);
  card.meta.outcome = state;
  setSection(card, 'Result', `_${now()}_\n\n${summary.join(' ')}${pr ? `\n\nPull request: ${pr}` : ''}`);
  delete card.meta.reopened_outcome;   // an explicit `done` replaces the outcome remembered by a reopen
  delete card.meta.busy_ms;
  clearShipping(board, card.id);
  const w = whereOf(card);
  setSection(card, 'Where we are', `- Goal: ${w.goal}\n- Done: ${w.done}\n- Next: nothing, card done (see Result)`);
  card.meta.status = 'done';
  card.meta.done_ms = String(Date.now());
  card.meta.updated = now();
  saveCard(card);
  console.log(`${card.id}: done. Your session stays open; the person may still talk to you.`);
  startNext(board, { quiet: true });
}

// Auto model or effort (empty on the card): one-shot Haiku call reads the card and picks. A manual value is never touched.
// The reason (or the fallback note) goes in the card as `auto_choice`. Any failure falls back to sonnet / medium.
function chooseAuto(board, card) {
  const needModel = !card.meta.model, needEffort = !card.meta.effort;
  if (!needModel && !needEffort) return;
  const text = ['Context', 'Constraints', 'Done looks like'].map(t => '## ' + t + '\n' + (section(card, t)?.body || '(empty)')).join('\n\n');
  const prompt = 'You choose the Claude model and reasoning effort for a coding agent that will work this task card.\n' +
    'Models: haiku (trivial, mechanical), sonnet (normal work), opus (hard, risky or large work). Efforts: low, medium, high, xhigh.\n' +
    'Card: ' + (card.meta.title || '') + '\nDone target: ' + (card.meta.done || 'none') + '\n\n' + text + '\n\n' +
    'Answer with ONLY one JSON object: {"model":"haiku|sonnet|opus","effort":"low|medium|high|xhigh","reason":"one short line"}';
  let model = 'sonnet', effort = 'medium', note = '';
  try {
    const r = spawnSync('claude', ['-p', '--model', 'haiku'], { input: prompt, encoding: 'utf8', timeout: 90000, shell: process.platform === 'win32' });
    if (r.error || r.status !== 0) throw new Error(r.error?.message || String(r.stderr || 'exit ' + r.status).trim().split('\n')[0]);
    const m = r.stdout.match(/\{[\s\S]*\}/);
    const j = JSON.parse(m ? m[0] : '');
    if (!MODELS.includes(j.model) || !['low', 'medium', 'high', 'xhigh'].includes(j.effort)) throw new Error('unusable answer');
    model = j.model; effort = j.effort;
    note = 'Haiku chose ' + [needModel && model, needEffort && effort].filter(Boolean).join('/') + ': ' + String(j.reason || 'no reason given').replace(/\s+/g, ' ').trim().slice(0, 200);
  } catch (e) {
    note = 'Haiku choice failed (' + String(e.message).replace(/\s+/g, ' ').slice(0, 120) + '): fell back to sonnet/medium';
  }
  if (needModel) card.meta.model = model;
  if (needEffort) card.meta.effort = effort;
  card.meta.auto_choice = note;
}

function cmdApprove(board, args) {
  const startNow = args.includes('--start');
  if (startNow) args.splice(args.indexOf('--start'), 1);
  const model = takeFlag(args, '--model');
  const effort = takeFlag(args, '--effort');
  const [id] = args;
  if (!id) die('usage: approve <id> [--model haiku|sonnet|opus] [--effort low|medium|high|xhigh|max] [--start]');
  const card = loadCard(board, id);
  if (model) card.meta.model = model;
  if (effort) card.meta.effort = effort;
  if (!MODELS.includes(card.meta.model || 'sonnet') || !EFFORTS.includes(card.meta.effort || 'medium')) die(`model must be one of ${MODELS.join(', ')}; effort one of ${EFFORTS.join(', ')}`);
  chooseAuto(board, card);   // Auto model/effort: Haiku picks, with a reason
  if (!MODELS.includes(card.meta.model)) die(`model must be one of ${MODELS.join(', ')}`);
  if (!EFFORTS.includes(card.meta.effort)) die(`effort must be one of ${EFFORTS.join(', ')}`);
  card.meta.approved = 'true';
  delete card.meta.start_error;   // approving again is the "try again"
  if ((card.meta.status || 'todo') === 'todo') card.meta.status = 'ready';
  saveCard(card);
  console.log(`${card.id}: ready (${card.meta.model}/${card.meta.effort})`);
  if (!startNow) return;
  if (card.meta.status !== 'ready') { console.log(`${card.id}: is ${card.meta.status}, not started again (use start to restart it)`); return; }
  // --start: run it now when a slot is free (maxParallel still applies); otherwise it waits in Ready like a plain approve
  const running = busyCount(board);
  if (running >= board.maxParallel) { console.log(`${card.id}: all slots are taken (${running}/${board.maxParallel} running): waiting in Ready`); return; }
  try { startCard(board, card); }
  catch (e) { die(`${card.id}: approved but could not start: ${recordStartError(board, card.id, e)}`); }
  console.log(`${card.id}: started as ${termName(card.id)}`);
}

// Undo an approve (or a mistaken Start click) while the card has not started: back to To do, no longer approved.
function cmdUnapprove(board, args) {
  const [id] = args;
  if (!id) die('usage: unapprove <id>');
  const card = loadCard(board, id);
  const status = card.meta.status || 'todo';
  if (status !== 'todo' && status !== 'ready') die(`${card.id} is ${status}: only a card that has not started can go back to To do`);
  card.meta.approved = 'false';
  card.meta.status = 'todo';
  saveCard(card);
  console.log(`${card.id}: back to To do`);
}

// Cards that may start, best first: ready ones, and todo ones pre-approved on the card.
function queue(board) {
  return allCards(board)
    .filter(c => !c.meta.start_error)   // a card that failed to start waits for a person (approve or start clears it), not the next tick
    .filter(c => c.meta.status === 'ready' || ((c.meta.status || 'todo') === 'todo' && c.meta.approved === 'true'))
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

// A slot is taken only by an agent that is alive and not stopped: a crashed or stalled agent
// shows under needs-you and does not hold the queue up.
function busyCount(board) {
  const live = liveTerminals(board);
  return allCards(board).filter(c => {
    if (c.meta.status !== 'running') return false;
    const t = live[termName(c.id)];
    return t && !['done', 'idle', 'error'].includes(t.status);
  }).length;
}

// Put the reason a card could not start on the card (it then waits for a person) and return it.
function recordStartError(board, id, e) {
  const fresh = loadCard(board, id);
  fresh.meta.start_error = String(e.message).replace(/\s+/g, ' ').slice(0, 200);
  saveCard(fresh);
  return fresh.meta.start_error;
}

// Called by you (next) and by agents (ask, done). A card that fails to start gets the reason on it;
// the caller's own command still succeeds.
function startNext(board, { quiet = false } = {}) {
  const running = busyCount(board);
  let free = board.maxParallel - running;
  const started = [];
  for (const c of queue(board)) {
    if (free <= 0) break;
    try {
      startCard(board, c);
      started.push(c.id);
      free--;
    } catch (e) {
      console.log(`${c.id}: could not start: ${recordStartError(board, c.id, e)}`);
    }
  }
  if (!quiet || started.length) console.log(started.length ? `started: ${started.join(', ')}` : `nothing to start (${running}/${board.maxParallel} running)`);
}

// The timer's one step (the panel calls it every 30 s; cron or a loop can too). Does nothing unless autoStart is
// on and a full interval has passed since the last run; then it is exactly `next`. board.json is read on every call,
// so changing the switch or the interval needs no restart. The last run is kept in <board>/.auto-start.
function cmdTick(board) {
  if (!board.autoStart.enabled) return;
  const file = join(board.dir, '.auto-start');
  let last = 0;
  try { last = Number(readFileSync(file, 'utf8')) || 0; } catch {}
  if (last > Date.now()) last = 0;   // clock moved back
  if (Date.now() - last < board.autoStart.intervalMinutes * 60000) return;
  // two panels may tick together: only the one that creates the lock file runs; a lock older than a minute is a crash's leftover
  const lock = file + '.lock';
  try { if (Date.now() - statSync(lock).mtimeMs > 60000) unlinkSync(lock); } catch { /* no lock */ }
  let fd;
  try { fd = openSync(lock, 'wx'); } catch { return; }   // the other panel has it
  try {
    let again = 0;
    try { again = Number(readFileSync(file, 'utf8')) || 0; } catch {}
    if (Date.now() - again < board.autoStart.intervalMinutes * 60000 && again <= Date.now()) return;   // the other panel just ran
    writeAtomic(file, String(Date.now()));   // first: a failure below must not make it retry every 30 s
    try { startNext(board, { quiet: true }); }
    catch (e) { console.log(`auto-start failed: ${e.message}`); }   // the timer goes on
  } finally { closeSync(fd); try { unlinkSync(lock); } catch {} }
}

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}
function gitWhy(e) { return String(e.stderr || e.message).trim().split('\n')[0]; }   // first line of git's error

// Starts the card's claude in its worktree as a named hc terminal. `claudeArgs` go right after "claude"
// (--session-id or --resume), `tail` after the board's own options (the opening prompt).
function launchAgent(board, card, wt, claudeArgs, tail) {
  const name = termName(card.id);
  const rules = renderRules(board, card);
  const args = ['run', '--bg', '--no-parent', '--outlive-parent', '--name', name, '--cwd', wt,
    '--label', `card=${card.id}`];
  if (board.space) args.push('--label', `herdr.space=${board.space}`);
  args.push('--', 'claude', ...claudeArgs, '--model', card.meta.model, '--effort', card.meta.effort, '--permission-mode', board.permissionMode || 'auto',
    '-n', `${card.id} ${card.meta.title}`.slice(0, 60),
    '--add-dir', slash(board.dir), '--append-system-prompt-file', rules, ...tail);
  hc(board, args);
  acceptTrustPrompt(board, name);
}

function startCard(board, card) {
  const repo = board.repos[card.meta.repo];
  if (!repo) die(`${card.id}: unknown repo "${card.meta.repo}"`);
  chooseAuto(board, card);
  const name = termName(card.id);
  if (liveTerminals(board)[name]) die(`${card.id}: its agent (${name}) is already running`);
  hc(board, ['rm', name], { json: false, allowFail: true });   // a finished one with the same name

  // worktree on branch card/<ID>
  const wt = slash(resolve(board.worktrees, card.id));
  const branch = `card/${card.id}`;
  if (!existsSync(wt)) {
    // a worktree folder deleted by hand stays registered in git and blocks the add: prune drops only those
    try { git(['-C', repo.path, 'worktree', 'prune']); } catch { /* the add reports any real problem */ }
    let hasBranch = true;
    try { git(['-C', repo.path, 'rev-parse', '--verify', '--quiet', branch]); } catch { hasBranch = false; }
    if (hasBranch) git(['-C', repo.path, 'worktree', 'add', wt, branch]);
    else {
      // start from the remote's latest base when there is a remote; a local main is often behind
      const base = repo.base || 'main';
      let from = base;
      if (git(['-C', repo.path, 'remote']).split('\n').includes('origin')) {
        // a base that exists only here (a local branch, a fork's work) can't be fetched: use it as it is
        try { git(['-C', repo.path, 'fetch', '--quiet', 'origin', base]); from = `origin/${base}`; } catch { from = base; }
      }
      git(['-C', repo.path, 'worktree', 'add', '--no-track', '-b', branch, wt, from]);
    }
  }

  allowShipCommands(board, wt, card);
  clearShipping(board, card.id);   // a flag left by an agent that was killed must not show on the fresh one

  const brief = `You are the agent for card ${card.id} ("${card.meta.title}"). Read your card first: ${slash(card.path)}. Then work it to its "done" target, following your card rules.`;
  const session = randomUUID();   // fixed here so Resume knows which transcript is this card's
  launchAgent(board, card, wt, ['--session-id', session], [brief]);
  card.meta.session = session;

  card.meta.status = 'running';
  card.meta.active_ms = String(Date.now());
  card.meta.started = now();
  delete card.meta.start_error;
  card.meta.branch = branch;
  card.meta.worktree = wt;
  saveCard(card);
}

// Claude Code can't scope a permission to a folder, so each card worktree gets its own untracked
// .claude/settings.local.json allowing what /ship needs and denying gh pr merge unless the card merges
// (merged into any existing file). It also holds the hooks that drive the "shipping" label (see cmdShipMark).
const SHIP_ALLOW = ['Bash(gh pr create:*)', 'Bash(gh pr edit:*)', 'Bash(gh pr checks:*)',
  'Bash(gh issue create:*)', 'Bash(gh issue list:*)', 'Bash(gh label create:*)', 'Bash(git push:*)'];
// gh pr merge is allowed only when the card's done target is "merged"; otherwise it is denied.
const MERGE_RULE = 'Bash(gh pr merge:*)';
function allowShipCommands(board, wt, card) {
  const merges = (card.meta.done || '').split('#')[0].trim() === 'merged';
  const wanted = merges ? [MERGE_RULE, ...SHIP_ALLOW] : SHIP_ALLOW;
  try {
    const file = join(wt, '.claude', 'settings.local.json');
    let cfg = {};
    if (existsSync(file)) cfg = JSON.parse(readFileSync(file, 'utf8'));   // unreadable: throws, file left alone
    cfg.permissions = cfg.permissions || {};
    let allow = Array.isArray(cfg.permissions.allow) ? cfg.permissions.allow : [];
    let deny = Array.isArray(cfg.permissions.deny) ? cfg.permissions.deny : [];
    const before = JSON.stringify(cfg);
    if (merges) deny = deny.filter(r => r !== MERGE_RULE);
    else { allow = allow.filter(r => r !== MERGE_RULE); if (!deny.includes(MERGE_RULE)) deny = [...deny, MERGE_RULE]; }
    const next = [...allow, ...wanted.filter(r => !allow.includes(r))];
    cfg.permissions.allow = next;
    if (deny.length) cfg.permissions.deny = deny; else delete cfg.permissions.deny;
    setShipHooks(cfg, board, card);
    if (JSON.stringify(cfg) !== before) {
      mkdirSync(dirname(file), { recursive: true });
      writeAtomic(file, JSON.stringify(cfg, null, 2) + '\n');
    }
    // keep it out of git without touching tracked files: the repo's info/exclude
    const ex = resolve(wt, git(['-C', wt, 'rev-parse', '--git-path', 'info/exclude']).trim());
    const cur = existsSync(ex) ? readFileSync(ex, 'utf8') : '';
    if (!cur.split(/\r?\n/).includes('.claude/settings.local.json')) {
      mkdirSync(dirname(ex), { recursive: true });
      writeFileSync(ex, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + '.claude/settings.local.json\n');
    }
  } catch (e) { console.error(`warning: could not write the card's permission rules: ${e.message}`); }
}

// The hooks that tell `ship-mark` when /ship starts (Skill tool, or typed by the person) and when the agent stops or the session ends.
// Ours are recognised by their command and replaced each time; the person's own hooks are kept.
const SHIP_HOOKS = [['PreToolUse', 'Skill'], ['UserPromptSubmit', undefined], ['Stop', undefined], ['SessionEnd', undefined]];
function setShipHooks(cfg, board, card) {
  const command = `node "${slash(join(HERE, 'herdr-board.mjs'))}" --board "${slash(board.dir)}" ship-mark ${card.id}`;
  const ours = (g) => Array.isArray(g?.hooks) && g.hooks.some(h => String(h?.command || '').includes(' ship-mark '));
  cfg.hooks = cfg.hooks && typeof cfg.hooks === 'object' ? cfg.hooks : {};
  for (const [event, matcher] of SHIP_HOOKS) {
    const kept = (Array.isArray(cfg.hooks[event]) ? cfg.hooks[event] : []).filter(g => !ours(g));
    cfg.hooks[event] = [...kept, { ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command }] }];
  }
}

// A new worktree opens on Claude's "trust this folder?" question: say yes for it.
function acceptTrustPrompt(board, name) {
  for (let i = 0; i < 20; i++) {
    const screen = hc(board, ['read', name], { json: false, allowFail: true }) || '';
    if (/trust this folder/i.test(screen)) { hc(board, ['keys', name, 'down', 'enter'], { json: false }); return; }
    if (/❯/.test(screen) && /effort|auto mode/i.test(screen)) return;   // already at its prompt
    sleepMs(1000);
  }
}

function renderRules(board, card) {
  const me = `node "${slash(join(HERE, 'herdr-board.mjs'))}" --board "${slash(board.dir)}"`;
  const text = readFileSync(join(HERE, 'rules.md'), 'utf8')
    .replaceAll('{{board}}', me).replaceAll('{{check}}', `node "${slash(join(HERE, 'check.mjs'))}"`).replaceAll('{{id}}', card.id);
  const dir = join(board.dir, '.rules');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${card.id}.md`);
  writeAtomic(path, text);
  return slash(path);
}

function cmdStart(board, [id]) {
  if (!id) die('usage: start <id>');
  const card = loadCard(board, id);
  if (['done', 'archived'].includes(card.meta.status)) die(`${card.id} is ${card.meta.status}`);
  startCard(board, card);
  console.log(`${card.id}: started as ${termName(card.id)}`);
}

// "Create with agent": a chat agent that asks the person what is missing, then writes the card with `new`.
function cmdDraft(board, args) {
  const fields = takeFlag(args, '--fields');
  const [repo, ...titleWords] = args;
  const title = titleWords.join(' ').trim();
  const r = board.repos[repo];
  if (!r) die(`unknown repo "${repo}"; board.json knows: ${Object.keys(board.repos).join(', ')}`);
  let f = {};
  if (fields) { try { f = JSON.parse(decodeURIComponent(fields)); } catch { die('--fields is not valid encoded JSON'); } }
  const dir = join(board.dir, '.rules');
  mkdirSync(dir, { recursive: true });
  const name = `draft-${Date.now().toString(36)}`;
  const me = `node "${slash(join(HERE, 'herdr-board.mjs'))}" --board "${slash(board.dir)}"`;
  const rules = join(dir, `${name}.md`);
  writeAtomic(rules, readFileSync(join(HERE, 'draft-rules.md'), 'utf8')
    .replaceAll('{{board}}', me).replaceAll('{{repo}}', repo).replaceAll('{{file}}', slash(join(dir, `${name}.json`))));
  const given = [['title', title], ['context', f.context], ['constraints', f.constraints], ['done looks like', f.doneLooks],
    ['finish with', f.done], ['model', f.model], ['effort', f.effort]].filter(([, v]) => String(v ?? '').trim())
    .map(([k, v]) => `- ${k}: ${String(v).trim()}`).join('\n') || '(nothing yet)';
  const brief = `Help me create a card on the "${repo}" board. What I wrote so far:\n${given}\nAsk me what is missing, then create the card.`;
  const args2 = ['run', '--bg', '--no-parent', '--outlive-parent', '--name', name, '--cwd', slash(r.path), '--label', 'draft=1'];
  if (board.space) args2.push('--label', `herdr.space=${board.space}`);
  args2.push('--', 'claude', '--model', 'sonnet', '--permission-mode', board.permissionMode || 'auto',
    '-n', `New card: ${title || repo}`.slice(0, 60), '--add-dir', slash(board.dir), '--append-system-prompt-file', slash(rules), brief);
  hc(board, args2);
  acceptTrustPrompt(board, name);
  console.log(liveTerminals(board)[name]?.address || name);   // what the panel focuses (a card's address, not its name)
}

// The panel's card editor: save <id> <text, encodeURIComponent> <hash of the text it opened, or "new">.
// Refuses when the card changed since (an agent wrote to it), so nothing is overwritten.
export function textHash(t) { let h = 5381; for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0; return h.toString(16); }

function cmdSave(board, [id, encoded, expected]) {
  if (!id || encoded === undefined || !expected) die('usage: save <id> <encodeURIComponent(text)> <hash|new>');
  const path = cardPath(board, id.toUpperCase());
  const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (expected !== 'new' && (current === null || textHash(current) !== expected)) die('the card changed since you opened it (an agent may have updated it). Reload it and edit again.');
  const text = decodeURIComponent(encoded);
  parseCard(text);   // must still be a card
  writeAtomic(path, text.endsWith('\n') ? text : text + '\n');
  console.log(`${id.toUpperCase()}: saved`);
}

// The card's form fields as JSON (the panel's card form), with the hash of the file to save against.
const PLACEHOLDERS = { 'Context': /^Why this matters, what you know/, 'Constraints': /^- What the agent must not do/, 'Done looks like': /^- What you will check/ };
function cmdShow(board, [id]) {
  if (!id) die('usage: show <id>');
  const card = loadCard(board, id);
  const text = (name) => { const b = (section(card, name)?.body || '').trim(); return PLACEHOLDERS[name].test(b) ? '' : b; };
  console.log(JSON.stringify({
    id: card.id, title: card.meta.title || '', repo: card.meta.repo || '', status: card.meta.status || 'todo',
    done: card.meta.done || '', model: card.meta.model || '', effort: card.meta.effort || '',
    context: text('Context'), constraints: text('Constraints'), doneLooks: text('Done looks like'),
    hash: textHash(readFileSync(card.path, 'utf8')),
  }));
}

// Change a card that has not started (To do or Ready): title, finish-with, model, effort and the three text sections.
function cmdUpdate(board, args) {
  const hash = takeFlag(args, '--hash');
  const fields = takeFlag(args, '--fields');
  const [id] = args;
  if (!id || !fields || !hash) die('usage: update <id> --hash <h> --fields <enc>');
  const card = loadCard(board, id);
  if (textHash(readFileSync(card.path, 'utf8')) !== hash) die('the card changed since you opened it (an agent may have updated it). Close the panel and open it again.');
  if (!['todo', 'ready'].includes(card.meta.status || 'todo')) die(`${card.id} has started: it can no longer be changed from the form`);
  let f;
  try { f = JSON.parse(decodeURIComponent(fields)); } catch { die('--fields is not valid encoded JSON'); }
  if (f.model && !MODELS.includes(f.model)) die(`model must be one of ${MODELS.join(', ')}`);
  if (f.effort && !EFFORTS.includes(f.effort)) die(`effort must be one of ${EFFORTS.join(', ')}`);
  const one = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim();
  const title = one(f.title);
  if (!title) die('the title cannot be empty');
  card.meta.title = title;
  card.meta.done = one(f.done) || card.meta.done;
  card.meta.model = one(f.model);
  card.meta.effort = one(f.effort);
  setSection(card, 'Context', String(f.context ?? '').trim());
  setSection(card, 'Constraints', String(f.constraints ?? '').trim());
  setSection(card, 'Done looks like', String(f.doneLooks ?? '').trim());
  card.meta.updated = now();
  saveCard(card);
  console.log(`${card.id}: updated`);
}

// The panel's settings that belong to the board itself:
// config maxParallel 3 | config autoStart on|off | config autoInterval 5 (minutes)
function cmdConfig(board, [key, value]) {
  const file = join(board.dir, 'board.json');
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  if (key === 'maxParallel') {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 1) die('maxParallel must be a whole number, 1 or more');
    raw.maxParallel = n;
  } else if (key === 'autoStart') {
    if (!['on', 'off'].includes(value)) die('autoStart must be on or off');
    raw.autoStart = { ...raw.autoStart, enabled: value === 'on' };
  } else if (key === 'autoInterval') {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 1440) die('autoInterval must be a whole number of minutes, 1 to 1440');
    raw.autoStart = { ...raw.autoStart, intervalMinutes: n };
  } else if (Object.values(CLEAN_KEYS).includes(key)) {
    if (!['on', 'off'].includes(value)) die(`${key} must be on or off`);
    const part = Object.keys(CLEAN_KEYS).find(k => CLEAN_KEYS[k] === key);
    raw.clean = { worktree: true, branch: true, archive: true, ...(raw.clean || {}), [part]: value === 'on' };
  } else die('usage: config maxParallel <number> | autoStart <on|off> | autoInterval <minutes> | cleanWorktree|cleanBranch|cleanArchive <on|off>');
  writeAtomic(file, JSON.stringify(raw, null, 2) + '\n');
  console.log(`${key} = ${['autoStart', 'autoInterval', ...Object.values(CLEAN_KEYS)].includes(key) ? value : raw[key]}`);
  if (key === 'maxParallel') startNext(loadBoard(board.dir), { quiet: true });   // more room: start what waits
}

// ---------- repos: add-repo / remove-repo / suggest-repos ----------
// board.json "repos" is the only list of repos the board knows. Nothing here runs by itself: a repo is added or removed
// only when the person asks (the CLI, or the panel after a confirmation).

const REPO_COLORS = ['#8b5cf6', '#0ea5e9', '#22c55e', '#f97316', '#eab308', '#ec4899', '#14b8a6', '#ef4444', '#6366f1', '#84cc16', '#06b6d4', '#a855f7'];
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function samePath(a, b) {
  const n = (p) => { const s = slash(resolve(String(p))).replace(/\/+$/, ''); return process.platform === 'win32' ? s.toLowerCase() : s; };
  return n(a) === n(b);
}

// The main folder of the git repo that holds `dir` (a card worktree gives back the repo it belongs to), or null
// when `dir` is not in a git repo (or does not exist).
function repoRoot(dir) {
  try {
    if (!dir || !statSync(dir).isDirectory()) return null;
    const common = slash(git(['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir']));
    if (/(^|\/)\.git$/.test(common)) return slash(dirname(common));
    return slash(git(['-C', dir, 'rev-parse', '--show-toplevel']));   // a bare repo fails here: not a repo to work in
  } catch { return null; }
}

// The branch cards start from: origin's default, else main, else master, else the one checked out.
function repoBase(path) {
  const tryGit = (a) => { try { return git(['-C', path, ...a]); } catch { return ''; } };
  const head = tryGit(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, '');
  if (head) return head;
  for (const b of ['main', 'master']) if (tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${b}`])) return b;
  const cur = tryGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  return cur && cur !== 'HEAD' ? cur : 'main';
}

// PREFIX from the name: the initials of its words (herdr-git-graph -> HGG), else its first letters (shepherdr -> SHE);
// longer, then numbered, when another repo already has it.
function repoPrefix(name, taken) {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const flat = words.join('').toUpperCase();
  const cands = [];
  if (words.length > 1) cands.push(words.map(w => w[0]).join('').toUpperCase().slice(0, 4));
  for (let n = 3; n <= 6; n++) cands.push(flat.slice(0, n));
  const free = (p) => /^[A-Z]/.test(p) && !taken.has(p);
  const hit = cands.find(free);
  if (hit) return hit;
  const stem = /^[A-Z]/.test(cands[0] || '') ? cands[0] : 'R';
  for (let i = 2; ; i++) if (free(`${stem}${i}`)) return `${stem}${i}`;
}

function repoColor(used) {
  const lower = new Set(used.map(c => String(c).toLowerCase()));
  return REPO_COLORS.find(c => !lower.has(c)) || REPO_COLORS[used.length % REPO_COLORS.length];
}

function takenPrefixes(board) { return new Set(Object.entries(board.repos).map(([k, r]) => (r.prefix || k).toUpperCase())); }

function repoOnBoard(board, root) {
  return Object.entries(board.repos).find(([, r]) => r.path && samePath(r.path, root))?.[0] || null;
}

// add-repo <name> <path> [--prefix P] [--base B] [--color #rrggbb] [--json]
function cmdAddRepo(board, args) {
  const json = takeSwitch(args, '--json');
  for (const f of ['--prefix', '--base', '--color']) if (args.indexOf(f) >= 0 && args.indexOf(f) === args.length - 1) die(`${f} needs a value`);
  const prefix = takeFlag(args, '--prefix');
  const base = takeFlag(args, '--base');
  const color = takeFlag(args, '--color');
  const [name, path] = args;
  if (!name || !path) die('usage: add-repo <name> <path> [--prefix P] [--base B] [--color #rrggbb]');
  if (!REPO_NAME.test(name)) die(`"${name}" is not a usable repo name (letters, digits, . _ - only)`);
  if (board.repos[name]) die(`repo "${name}" is already on the board (${board.repos[name].path})`);
  if (prefix !== undefined && !/^[A-Za-z][A-Za-z0-9]{0,7}$/.test(prefix)) die('prefix must be 1 to 8 letters or digits, starting with a letter');
  if (color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(color)) die('color must look like #8b5cf6');
  if (base !== undefined && !/^[A-Za-z0-9][\w./-]*$/.test(base)) die(`"${base}" is not a usable branch name`);
  const root = repoRoot(resolve(path));
  if (!root) die(`${path} is not a git repo (or does not exist)`);
  const dupe = repoOnBoard(board, root);
  if (dupe) die(`${root} is already on the board as "${dupe}"`);
  const taken = takenPrefixes(board);
  const entry = {
    path: root,
    prefix: (prefix ?? repoPrefix(name, taken)).toUpperCase(),
    base: base ?? repoBase(root),
    color: color ? color.toLowerCase() : repoColor(Object.values(board.repos).map(r => r.color || '')),
  };
  if (taken.has(entry.prefix)) die(`prefix ${entry.prefix} is already used by another repo; pick another with --prefix`);
  const file = join(board.dir, 'board.json');
  const raw = JSON.parse(readFileSync(file, 'utf8'));   // the raw file, so fields this code does not know are kept
  raw.repos = { ...(raw.repos || {}), [name]: entry };
  writeAtomic(file, JSON.stringify(raw, null, 2) + '\n');
  console.log(json ? JSON.stringify({ name, ...entry }) : `added ${name}: ${entry.path} (prefix ${entry.prefix}, base ${entry.base}, color ${entry.color})`);
}

// remove-repo <name> [--json]: only the entry in board.json goes. Its folder, worktrees and cards stay as they are.
// Refused while a card that is not archived still uses it: clean, resume and the agent need the repo.
function cmdRemoveRepo(board, args) {
  const json = takeSwitch(args, '--json');
  const [name] = args;
  if (!name) die('usage: remove-repo <name>');
  if (!board.repos[name]) die(`unknown repo "${name}"; board.json knows: ${Object.keys(board.repos).join(', ')}`);
  const users = allCards(board).filter(c => c.meta.repo === name);
  // a card file that cannot be read cannot be checked: do not guess that it is not using the repo
  const readable = new Set(allCards(board).map(c => c.id));
  const unreadable = existsSync(board.cardsDir) ? readdirSync(board.cardsDir).filter(f => f.endsWith('.md') && !readable.has(f.slice(0, -3).toUpperCase())) : [];
  if (unreadable.length) die(`cannot check which cards use "${name}": unreadable card file(s): ${unreadable.join(', ')}`);
  const active = users.filter(c => c.meta.status !== 'archived');
  if (active.length) die(`cannot remove "${name}": ${active.length} card${active.length > 1 ? 's' : ''} still use it (${active.map(c => c.id).join(', ')}). Finish and Clean them first`);
  const file = join(board.dir, 'board.json');
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  delete raw.repos[name];
  writeAtomic(file, JSON.stringify(raw, null, 2) + '\n');
  const kept = users.length ? `; ${users.length} archived card${users.length > 1 ? 's' : ''} kept (add the repo again to resume them)` : '';
  console.log(json ? JSON.stringify({ name, archivedCards: users.length }) : `removed ${name} from the board (its folder, worktrees and cards are untouched${kept})`);
}

// suggest-repos <folder>...: of these folders (the Herdr Spaces'), the git repos that are not on the board yet, as JSON
// [{name, path, prefix, base, color}]. A worktree of a repo gives that repo. Adds nothing.
function cmdSuggestRepos(board, folders) {
  const out = [];
  const names = new Set(Object.keys(board.repos));
  const taken = takenPrefixes(board);
  const used = Object.values(board.repos).map(r => r.color || '');
  for (const f of folders) {
    const root = repoRoot(f);
    if (!root || repoOnBoard(board, root) || out.some(o => samePath(o.path, root))) continue;
    let name = basename(root).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '') || 'repo';
    for (let i = 2; names.has(name); i++) name = `${name.replace(/-\d+$/, '')}-${i}`;
    names.add(name);
    const prefix = repoPrefix(name, taken);
    const color = repoColor(used);
    taken.add(prefix);
    used.push(color);
    out.push({ name, path: root, prefix, base: repoBase(root), color });
  }
  console.log(JSON.stringify(out));
}

// Terminals (any name) whose working folder is the given folder or inside it.
function terminalsIn(board, dir) {
  const norm = (p) => slash(String(p || '')).replace(/\/+$/, '').toLowerCase();
  const root = norm(dir);
  const r = hc(board, ['ls'], { allowFail: true });
  return (r?.terminals || []).filter(t => { const c = norm(t.cwd); return c === root || c.startsWith(root + '/'); });
}

function openIn(board, dir) { return terminalsIn(board, dir).map(t => `${t.name || t.address} (${t.address})`); }

function stopTerminalsIn(board, dir) {
  const stopped = [];
  for (const t of terminalsIn(board, dir)) {
    hc(board, ['kill', t.address], { json: false, allowFail: true });
    hc(board, ['rm', t.address], { json: false, allowFail: true });
    stopped.push(t.name || t.address);
  }
  return stopped;
}

// Windows keeps a folder busy for a moment after its process dies: retry a few times (about 4 s) on busy/permission errors.
function retryBusy(fn) {
  for (let i = 0; ; i++) {
    try { return fn(); }
    catch (e) {
      const msg = `${e.code || ''} ${e.message || ''} ${e.stderr || ''}`;
      if (i >= 8 || !/EBUSY|EPERM|EACCES|ENOTEMPTY|Device or resource busy|in use|Permission denied|Directory not empty/i.test(msg)) throw e;
      sleepMs(500);
    }
  }
}

// Clean: always stops the agent; then, as the board's "clean" settings say (config cleanWorktree|cleanBranch|cleanArchive):
// removes the worktree, deletes the branch, moves the card to archived.
function cmdClean(board, args) {
  const force = args.includes('--force');
  if (force) args.splice(args.indexOf('--force'), 1);
  const [id] = args;
  if (!id) die('usage: clean <id> [--force]   (stops its agent; removes the worktree, deletes the branch and archives the card as the board settings say)');
  const card = loadCard(board, id);
  if (card.meta.status !== 'done' && !force) die(`${card.id} is ${card.meta.status || 'todo'}: only a done card can be cleaned (--force to clean it anyway)`);
  const opt = board.clean;
  const name = termName(card.id);
  const repo = board.repos[card.meta.repo];
  const branch = card.meta.branch || `card/${card.id}`;
  const did = ['agent stopped'];
  clearShipping(board, card.id);
  hc(board, ['kill', name], { json: false, allowFail: true });
  hc(board, ['rm', name], { json: false, allowFail: true });
  if (opt.worktree && card.meta.worktree && existsSync(card.meta.worktree)) {
    // Windows refuses to delete a folder some terminal still sits in: stop every terminal whose cwd is inside it
    // (not when git will refuse anyway because of uncommitted work: keep those terminals alive)
    let dirty = false;
    try { dirty = git(['-C', card.meta.worktree, 'status', '--porcelain']) !== ''; } catch { /* not a worktree any more: nothing to protect */ }
    const stopped = dirty ? [] : stopTerminalsIn(board, card.meta.worktree);
    if (stopped.length) did.push(`stopped ${stopped.length} terminal(s) in the worktree (${stopped.join(', ')})`);
    try { retryBusy(() => git(['-C', repo.path, 'worktree', 'remove', card.meta.worktree], { env: { ...process.env, LC_ALL: 'C' } })); did.push('worktree removed'); }   // LC_ALL=C: the message below is matched in English
    catch (e) {
      const why = gitWhy(e);
      if (/is not a working tree/.test(why)) {
        // git no longer knows this folder (a leftover): remove it only when empty, else leave it and say so
        let left = [];
        try { left = readdirSync(card.meta.worktree); } catch { /* unreadable */ }
        if (left.length) die(`${card.id}: ${card.meta.worktree} is not a git worktree but has ${left.length} file(s) (${left.slice(0, 5).join(', ')}); left in place`);
        try { retryBusy(() => rmdirSync(card.meta.worktree)); did.push('empty leftover worktree folder removed'); }
        catch (e2) {
          const still = openIn(board, card.meta.worktree);
          die(`${card.id}: could not remove empty folder ${card.meta.worktree}: ${e2.message}${still.length ? `. Still open in: ${still.join(', ')}` : ''}`);
        }
      } else {
        let files = '';
        try { files = git(['-C', card.meta.worktree, 'status', '--porcelain']).split('\n').filter(Boolean).slice(0, 8).join('; '); } catch { /* none */ }
        const still = openIn(board, card.meta.worktree);
        die(`${card.id}: worktree not removed, left in place (${card.meta.worktree}). ${files ? `Changes: ${files}. ` : ''}${still.length ? `Still open in: ${still.join(', ')}. ` : ''}Git said: ${why}`);
      }
    }
  }
  let note = '';
  if (opt.branch && repo) {
    let exists = true;
    try { git(['-C', repo.path, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]); } catch { exists = false; }
    if (exists) {
      try { git(['-C', repo.path, 'branch', '-d', branch]); did.push(`branch ${branch} deleted`); }
      catch (e) {
        // not merged into the checked-out branch (a PR merged on GitHub leaves local main behind): still safe when a remote has it
        let remote = '';
        try { remote = git(['-C', repo.path, 'branch', '-r', '--contains', branch]); } catch { /* none */ }
        if (!remote) note = `branch ${branch} kept: it has commits that are neither merged nor on a remote (git branch -D ${branch} to force)`;
        else {
          try { git(['-C', repo.path, 'branch', '-D', branch]); did.push(`branch ${branch} deleted`); }
          // e.g. still checked out in a worktree that was kept (cleanWorktree off): never lose the archive step over it
          catch (e2) { note = `branch ${branch} kept: ${gitWhy(e2)}`; }
        }
      }
    }
  }
  if (opt.archive) {
    card.meta.status = 'archived';
    card.meta.updated = now();
    saveCard(card);
    did.push('card archived');
  }
  console.log(`${card.id}: ${did.join(', ')}${note ? '. ' + note : ''}`);
}

// Resume: an archived card gets its worktree back (from the local branch, else the remote one) and its agent
// continues the saved conversation (claude --resume <session>). The card goes back to Done; the usual "agent is busy"
// check moves it to Running when the agent works again. Never into a worktree with uncommitted changes.
function claudeProjectDir(wt) { return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects', String(wt).replace(/[^A-Za-z0-9]/g, '-')); }
function cmdResume(board, [id]) {
  if (!id) die('usage: resume <id>   (archived cards only)');
  const card = loadCard(board, id);
  if (card.meta.status !== 'archived') die(`${card.id} is ${card.meta.status || 'todo'}: only an archived card can be resumed`);
  const repo = board.repos[card.meta.repo];
  if (!repo) die(`${card.id}: unknown repo "${card.meta.repo}"`);
  const session = card.meta.session;
  if (!session) die(`${card.id}: no saved session (it was archived before sessions were saved): cannot resume its conversation`);
  const wt = slash(resolve(board.worktrees, card.id));
  const branch = card.meta.branch || `card/${card.id}`;
  const transcript = join(claudeProjectDir(wt), `${session}.jsonl`);
  if (!existsSync(transcript)) die(`${card.id}: the conversation file for session ${session} is gone (${transcript}): cannot resume`);
  if (liveTerminals(board)[termName(card.id)]) die(`${card.id}: its agent (${termName(card.id)}) is already running`);

  if (existsSync(wt)) {
    let dirty = '';
    try { dirty = git(['-C', wt, 'status', '--porcelain']); } catch (e) { die(`${card.id}: ${wt} exists but is not a usable git worktree (${gitWhy(e)}); left alone`); }
    let head = '';
    try { head = git(['-C', wt, 'rev-parse', '--abbrev-ref', 'HEAD']); } catch { /* reported above */ }
    if (head !== branch) die(`${card.id}: ${wt} already exists but is on "${head}", not ${branch}; not resuming into it`);
    if (dirty) die(`${card.id}: ${wt} already exists with uncommitted changes (${dirty.split('\n').slice(0, 5).join('; ')}); not resuming into it. Commit or discard them, then resume again`);
  } else {
    try { git(['-C', repo.path, 'worktree', 'prune']); } catch { /* the add reports any real problem */ }
    let local = true;
    try { git(['-C', repo.path, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]); } catch { local = false; }
    if (local) git(['-C', repo.path, 'worktree', 'add', wt, branch]);
    else {
      let remote = true, fetchWhy = '';
      try { git(['-C', repo.path, 'fetch', '--quiet', 'origin', branch], { env: { ...process.env, LC_ALL: 'C' } }); } catch (e) { remote = false; fetchWhy = gitWhy(e); }
      // a fetch that failed for another reason (offline, auth) does not prove the branch is gone: say so, leave the card alone
      if (!remote && !/couldn't find remote ref|does not appear to be a git repository|No such remote/i.test(fetchWhy)) die(`${card.id}: could not fetch ${branch} from origin: ${fetchWhy}`);
      if (remote) try { git(['-C', repo.path, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]); } catch { remote = false; }
      if (!remote) {
        const w = whereOf(card);
        setSection(card, 'Where we are', `- Goal: ${w.goal}
- Done: ${w.done}
- Next: cannot resume: branch ${branch} is gone locally and on origin`);
        saveCard(card);   // `updated` is the archive date (sorts the Archived column): not touched by a failed resume
        die(`${card.id}: branch ${branch} is gone locally and on origin: not recreating the worktree from nothing`);
      }
      git(['-C', repo.path, 'worktree', 'add', '-b', branch, wt, `origin/${branch}`]);
    }
  }

  allowShipCommands(board, wt, card);
  clearShipping(board, card.id);
  hc(board, ['rm', termName(card.id)], { json: false, allowFail: true });
  launchAgent(board, card, wt, ['--resume', session], []);
  const w = whereOf(card);
  card.meta.status = 'done';
  card.meta.outcome = card.meta.outcome || 'reached';
  card.meta.done_ms = String(Date.now());
  card.meta.worktree = wt;
  card.meta.branch = branch;
  delete card.meta.busy_ms;
  setSection(card, 'Where we are', `- Goal: ${w.goal}
- Done: ${w.done}
- Next: resumed from the archive (worktree recreated, conversation continued)`);
  card.meta.updated = now();
  saveCard(card);
  console.log(`${card.id}: resumed as ${termName(card.id)} (session ${session})`);
}

// ---------- setup ----------

// The id of this copy of the CLI: a hash of the files deploy.sh copies (line endings ignored), so the same checkout gives
// the same id on every machine and the panel can tell an older server copy.
const DEPLOYED = ['herdr-board.mjs', 'check.mjs', 'rules.md', 'draft-rules.md', 'card-template.md'];   // what deploy.sh copies: keep in step
let cliId;   // read once: the files cannot change under a running process
function cliVersion() {
  cliId ??= textHash(DEPLOYED.map(f => { try { return readFileSync(join(HERE, f), 'utf8').replace(/\r/g, ''); } catch { return ''; } }).join('\0'));
  return cliId;
}

// init <folder> [--name N] [--worktrees D]: a new board. Never touches an existing one.
function cmdInit(args) {
  const name = takeFlag(args, '--name');
  const worktrees = takeFlag(args, '--worktrees');
  const [folder, ...extra] = args;
  if (!folder || extra.length || [name, worktrees].some(v => v?.startsWith('--'))) die('usage: init <folder> [--name N] [--worktrees D]');
  const dir = resolve(folder), file = join(dir, 'board.json');
  if (existsSync(file)) die(`${slash(file)} already exists: that folder already holds a board`);
  const board = { name: name || basename(dir), maxParallel: 2, worktrees: slash(worktrees ? resolve(worktrees) : join(dir, 'worktrees')), repos: {} };
  try {
    mkdirSync(join(dir, 'cards'), { recursive: true });
    writeAtomic(file, JSON.stringify(board, null, 2) + '\n');
  } catch (e) { die(`cannot create the board in ${slash(dir)}: ${e.message}`); }
  console.log(`created ${slash(file)} and ${slash(join(dir, 'cards'))}`);
  console.log(`next: node ${slash(fileURLToPath(import.meta.url))} --board ${slash(dir)} add-repo <name> <path of a git repo>`);
  console.log('then put the same two paths (this CLI and the folder) in the panel: ⚙ → Boards');
}

// ---------- main ----------

// The tests import this file for its functions. Node 24.2+ tells whether this file was started directly
// (import.meta.main); on older Node, HERDR_BOARD_NO_MAIN=1 keeps the command line below from running.
export { parseCard, renderCard, section, applyFields, nextActionOf, display, whereOf, questionsOf, answersOf, termName, autoInterval, clip, shipEventOf, setShipHooks };

function main() {
  const argv = process.argv.slice(2);
  const boardDir = resolve(takeFlag(argv, '--board') || process.env.HERDR_BOARD || join(HERE, '..', 'board'));
  const [cmd, ...rest] = argv;
  if (cmd === 'version') return console.log(cliVersion());
  if (cmd === 'init') {   // there is no board yet: it must not load one
    try { return cmdInit(rest); } catch (e) { console.error(`herdr-board: ${e instanceof BoardError ? e.message : e.stack}`); process.exit(1); }
  }
  const commands = {
    new: cmdNew, draft: cmdDraft, ls: cmdLs, approve: cmdApprove, unapprove: cmdUnapprove, next: (b) => startNext(b), start: cmdStart,
    answer: cmdAnswer, press: cmdPress, clean: cmdClean, resume: cmdResume, save: cmdSave, show: cmdShow, update: cmdUpdate, config: cmdConfig, 'add-repo': cmdAddRepo, 'remove-repo': cmdRemoveRepo, 'suggest-repos': cmdSuggestRepos, tick: cmdTick, where: cmdWhere, ask: cmdAsk, done: cmdDone, 'ship-mark': cmdShipMark,
  };
  if (!cmd || !commands[cmd]) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(4, 11).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(cmd ? 1 : 0);
  }
  try {
    commands[cmd](loadBoard(boardDir), rest);
  } catch (e) {
    if (cmd === 'ship-mark') return;   // a hook never fails, even when the board folder is gone
    console.error(`herdr-board: ${e instanceof BoardError ? e.message : e.stack}`);
    process.exit(1);
  }
}
if (typeof import.meta.main === 'boolean' ? import.meta.main : process.env.HERDR_BOARD_NO_MAIN !== '1') main();
