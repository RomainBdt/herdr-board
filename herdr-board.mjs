#!/usr/bin/env node
// herdr-board: a kanban of Claude Code agents. Cards are Markdown files; each running card is a named
// hc terminal in its own git worktree. Runs on the machine that holds the repos (the "server").
// No packages: Node's standard library only.
//
//   you:    new <repo> "<title>" [--fields <enc> | --fields-file <json>] | draft <repo> ["<title>"] [--fields <enc>] | plan | approve <id> [--model m] [--effort e] | next | start <id>
//           answer <id> ["<text>"] | ls [--json] | clean <id> | tick | config <key> <value>
//   agent:  where <id> "<goal>" "<done>" "<next>" | ask <id> "<q1>" ["<q2>" ...] | done <id> "<summary>"
//
// The board folder comes from --board <dir>, else HERDR_BOARD, else the folder of this script's parent "board".

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

function takeFlag(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
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
  const r = spawnSync('hc', json ? [args[0], '--json', ...args.slice(1)] : args, { env: hcEnv(board), encoding: 'utf8' });
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

function saveCard(card) { writeAtomic(card.path, renderCard(card)); }

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

// What the board should show, from the card's status and its agent's live state.
function display(card, live) {
  const status = card.meta.status || 'todo';
  if (card.meta.start_error && status !== 'running') return { column: 'needs-you', note: `could not start: ${card.meta.start_error}` };
  if (status !== 'running') return { column: status, note: '' };
  const t = live[termName(card.id)];
  if (!t) return { column: 'needs-you', note: 'agent stopped (no terminal)' };
  if (t.status === 'blocked') return { column: 'needs-you', note: 'waiting on a prompt in its session' };
  if (t.status === 'error') return { column: 'needs-you', note: 'agent reported an error' };
  // just started or just answered: an agent reads as idle for a moment before its turn begins
  const fresh = Date.now() - Number(card.meta.active_ms || 0) < 90000;
  if (!fresh && (t.status === 'done' || t.status === 'idle')) return { column: 'needs-you', note: 'agent stopped without asking or finishing' };
  return { column: 'running', note: '' };
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

function cmdLs(board, args) {
  const live = liveTerminals(board);
  const cards = allCards(board).map(c => {
    const d = display(c, live);
    const repo = board.repos[c.meta.repo] || {};
    return {
      id: c.id, title: c.meta.title || '', repo: c.meta.repo || '', color: repo.color || '#888888',
      status: c.meta.status || 'todo', column: d.column, note: d.note,
      done: c.meta.done || '', model: c.meta.model || '', effort: c.meta.effort || '',
      approved: c.meta.approved === 'true',
      proposed: c.meta.proposed_model
        ? { model: c.meta.proposed_model, effort: c.meta.proposed_effort, order: Number(c.meta.proposed_order) || 99, note: c.meta.plan_note || '' }
        : null,
      where: whereOf(c), questions: questionsOf(c),
      terminal: live[termName(c.id)] ? termName(c.id) : '',
      address: live[termName(c.id)]?.address || '',
      agent: live[termName(c.id)]?.status || '',
      path: slash(c.path),
    };
  });
  const running = cards.filter(c => c.column === 'running').length;   // same rule as the queue's free slots
  if (args.includes('--json')) {
    const repos = Object.fromEntries(Object.entries(board.repos).map(([k, r]) => [k, r.color || '#888888']));
    console.log(JSON.stringify({ board: board.name || '', maxParallel: board.maxParallel, plannerModel: board.plannerModel || 'sonnet', autoStart: board.autoStart, clean: board.clean, running, repos, cards }, null, 2));
    return;
  }
  console.log(`${board.name || 'board'}: ${running}/${board.maxParallel} running`);
  for (const col of STATUSES) {
    const list = cards.filter(c => c.column === col);
    if (!list.length) continue;
    console.log(`\n${col.toUpperCase()} (${list.length})`);
    for (const c of list) {
      const mod = c.model ? `${c.model}/${c.effort}` : c.proposed ? `proposed ${c.proposed.model}/${c.proposed.effort}` : '';
      console.log(`  ${c.id.padEnd(9)} ${c.title}  [${c.repo}${mod ? ' · ' + mod : ''}]${c.note ? '  ⚠ ' + c.note : ''}`);
      if (c.where.next) console.log(`            → ${c.where.next}`);
      for (const q of c.questions) if (c.column === 'needs-you') console.log(`            ? ${q}`);
    }
  }
}

function cmdWhere(board, [id, goal, done, next]) {
  if (!id || next === undefined) die('usage: where <id> "<goal>" "<done>" "<next>"');
  const card = loadCard(board, id);
  setSection(card, 'Where we are', `- Goal: ${goal}\n- Done: ${done}\n- Next: ${next}`);
  card.meta.updated = now();
  saveCard(card);
  console.log(`${card.id}: updated "Where we are"`);
}

function cmdAsk(board, [id, ...qs]) {
  if (!id || !qs.length) die('usage: ask <id> "<question 1>" ["<question 2>" ...]');
  const card = loadCard(board, id);
  // an earlier round of questions and answers moves to History, so the card shows only the open ones
  const oldQ = section(card, 'Questions')?.body || '';
  if (oldQ.trim()) {
    const oldA = answersOf(card) || '(no answers)';
    const hist = section(card, 'History')?.body || '';
    setSection(card, 'History', `${hist}\n\n${oldQ}\n\nAnswers: ${oldA}`.trim());
  }
  setSection(card, 'Questions', `_Asked ${now()}_\n\n` + qs.map((q, i) => `${i + 1}. ${q}`).join('\n'));
  setSection(card, 'Answers', ANSWERS_HINT(card.id));
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
  const card = loadCard(board, id);
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

function cmdDone(board, [id, ...summary]) {
  if (!id || !summary.length) die('usage: done <id> "<summary>"');
  const card = loadCard(board, id);
  setSection(card, 'Result', `_${now()}_\n\n${summary.join(' ')}`);
  const w = whereOf(card);
  setSection(card, 'Where we are', `- Goal: ${w.goal}\n- Done: ${w.done}\n- Next: nothing, card done (see Result)`);
  card.meta.status = 'done';
  card.meta.updated = now();
  saveCard(card);
  console.log(`${card.id}: done. Your session stays open; the person may still talk to you.`);
  startNext(board, { quiet: true });
}

function cmdApprove(board, args) {
  const model = takeFlag(args, '--model');
  const effort = takeFlag(args, '--effort');
  const [id] = args;
  if (!id) die('usage: approve <id> [--model haiku|sonnet|opus] [--effort low|medium|high|xhigh|max]');
  const card = loadCard(board, id);
  card.meta.model = model || card.meta.model || card.meta.proposed_model || 'sonnet';
  card.meta.effort = effort || card.meta.effort || card.meta.proposed_effort || 'medium';
  if (!MODELS.includes(card.meta.model)) die(`model must be one of ${MODELS.join(', ')}`);
  if (!EFFORTS.includes(card.meta.effort)) die(`effort must be one of ${EFFORTS.join(', ')}`);
  card.meta.approved = 'true';
  if ((card.meta.status || 'todo') === 'todo') card.meta.status = 'ready';
  saveCard(card);
  console.log(`${card.id}: ready (${card.meta.model}/${card.meta.effort})`);
}

// Cards that may start, best first: ready ones, and todo ones pre-approved on the card.
function queue(board) {
  return allCards(board)
    .filter(c => c.meta.status === 'ready' || ((c.meta.status || 'todo') === 'todo' && c.meta.approved === 'true'))
    .sort((a, b) => (Number(a.meta.proposed_order) || 99) - (Number(b.meta.proposed_order) || 99) || a.id.localeCompare(b.id));
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
      const fresh = loadCard(board, c.id);
      fresh.meta.start_error = String(e.message).replace(/\s+/g, ' ').slice(0, 200);
      saveCard(fresh);
      console.log(`${c.id}: could not start: ${fresh.meta.start_error}`);
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
  writeAtomic(file, String(Date.now()));   // first: a failure below must not make it retry every 30 s
  try { startNext(board, { quiet: true }); }
  catch (e) { console.log(`auto-start failed: ${e.message}`); }   // the timer goes on
}

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

function startCard(board, card) {
  const repo = board.repos[card.meta.repo];
  if (!repo) die(`${card.id}: unknown repo "${card.meta.repo}"`);
  const model = card.meta.model || card.meta.proposed_model || 'sonnet';
  const effort = card.meta.effort || card.meta.proposed_effort || 'medium';
  const name = termName(card.id);
  if (liveTerminals(board)[name]) die(`${card.id}: its agent (${name}) is already running`);
  hc(board, ['rm', name], { json: false, allowFail: true });   // a finished one with the same name

  // worktree on branch card/<ID>
  const wt = slash(resolve(board.worktrees, card.id));
  const branch = `card/${card.id}`;
  if (!existsSync(wt)) {
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

  const rules = renderRules(board, card);
  const brief = `You are the agent for card ${card.id} ("${card.meta.title}"). Read your card first: ${slash(card.path)}. Then work it to its "done" target, following your card rules.`;
  const args = ['run', '--bg', '--no-parent', '--outlive-parent', '--name', name, '--cwd', wt,
    '--label', `card=${card.id}`];
  if (board.space) args.push('--label', `herdr.space=${board.space}`);
  args.push('--', 'claude', '--model', model, '--effort', effort, '--permission-mode', board.permissionMode || 'auto',
    '-n', `${card.id} ${card.meta.title}`.slice(0, 60),
    '--add-dir', slash(board.dir), '--append-system-prompt-file', rules, brief);
  hc(board, args);
  acceptTrustPrompt(board, name);

  card.meta.status = 'running';
  card.meta.active_ms = String(Date.now());
  card.meta.model = model;
  card.meta.effort = effort;
  card.meta.started = now();
  delete card.meta.start_error;
  card.meta.branch = branch;
  card.meta.worktree = wt;
  saveCard(card);
}

// A new worktree opens on Claude's "trust this folder?" question: say yes for it.
function acceptTrustPrompt(board, name) {
  for (let i = 0; i < 20; i++) {
    const screen = hc(board, ['read', name], { json: false, allowFail: true }) || '';
    if (/trust this folder/i.test(screen)) { hc(board, ['keys', name, 'down', 'enter'], { json: false }); return; }
    if (/❯/.test(screen) && /effort|auto mode/i.test(screen)) return;   // already at its prompt
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
}

function renderRules(board, card) {
  const me = `node "${slash(join(HERE, 'herdr-board.mjs'))}" --board "${slash(board.dir)}"`;
  const text = readFileSync(join(HERE, 'rules.md'), 'utf8')
    .replaceAll('{{board}}', me).replaceAll('{{id}}', card.id);
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
  args2.push('--', 'claude', '--model', board.plannerModel || 'sonnet', '--permission-mode', board.permissionMode || 'auto',
    '-n', `New card: ${title || repo}`.slice(0, 60), '--add-dir', slash(board.dir), '--append-system-prompt-file', slash(rules), brief);
  hc(board, args2);
  acceptTrustPrompt(board, name);
  console.log(liveTerminals(board)[name]?.address || name);   // what the panel focuses (a card's address, not its name)
}

function cmdPlan(board, args) {
  const model = takeFlag(args, '--model') || board.plannerModel || 'sonnet';
  const cards = allCards(board).filter(c => ['todo', 'ready'].includes(c.meta.status || 'todo'));
  if (!cards.length) { console.log('nothing to plan'); return; }
  const running = allCards(board).filter(c => c.meta.status === 'running')
    .map(c => `- ${c.id} [${c.meta.repo}] ${c.meta.title} (${c.meta.model}/${c.meta.effort})`).join('\n') || '(none)';
  const listing = cards.map(c => {
    const body = c.sections.filter(s => ['Context', 'Constraints', 'Done looks like'].includes(s.title))
      .map(s => `### ${s.title}\n${s.body}`).join('\n');
    return `## ${c.id} [repo ${c.meta.repo}] ${c.meta.title}\ndone target: ${c.meta.done}\n` +
      (c.meta.model ? `model fixed by the person: ${c.meta.model}/${c.meta.effort}\n` : '') + body;
  }).join('\n\n');
  const prompt = `You plan a board of Claude Code agent cards. Up to ${board.maxParallel} run at once, each in its own git worktree.
Running now:\n${running}\n\nCards waiting:\n\n${listing}\n
For each waiting card choose:
- model: haiku (small, mechanical), sonnet (most work), opus (hard design, tricky debugging, wide refactors)
- effort: low | medium | high | xhigh (only for genuinely hard cards)
- order: 1 = start first. Favour unblocking work, small quick wins, and cards in different repos running side by side; put cards that touch the same files of one repo apart.
- note: one short line on why.
Keep a model the person fixed. Reply with ONLY a JSON array: [{"id":"X-1","model":"sonnet","effort":"medium","order":1,"note":"..."}]`;
  const r = spawnSync('claude', ['-p', '--model', model, '--output-format', 'text'], { input: prompt, encoding: 'utf8', maxBuffer: 1 << 24 });
  if (r.status !== 0) die(`planner failed: ${r.stderr || r.stdout}`);
  const m = r.stdout.match(/\[[\s\S]*\]/);
  if (!m) die(`planner gave no JSON:\n${r.stdout}`);
  const plan = JSON.parse(m[0]);
  for (const p of plan) {
    const card = cards.find(c => c.id === String(p.id).toUpperCase());
    if (!card) continue;
    card.meta.proposed_model = MODELS.includes(p.model) ? p.model : 'sonnet';
    card.meta.proposed_effort = EFFORTS.includes(p.effort) ? p.effort : 'medium';
    card.meta.proposed_order = String(p.order ?? 99);
    card.meta.plan_note = String(p.note || '').replace(/\s+/g, ' ').slice(0, 140);
    saveCard(card);
    console.log(`${String(p.order).padStart(2)}. ${card.id.padEnd(9)} ${card.meta.proposed_model}/${card.meta.proposed_effort}  ${card.meta.plan_note}`);
  }
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

// The panel's settings that belong to the board itself:
// config maxParallel 3 | config plannerModel opus | config autoStart on|off | config autoInterval 5 (minutes)
function cmdConfig(board, [key, value]) {
  const file = join(board.dir, 'board.json');
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  if (key === 'maxParallel') {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 10) die('maxParallel must be a whole number from 1 to 10');
    raw.maxParallel = n;
  } else if (key === 'plannerModel') {
    if (!MODELS.includes(value)) die(`plannerModel must be one of ${MODELS.join(', ')}`);
    raw.plannerModel = value;
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
  } else die('usage: config maxParallel <1-10> | plannerModel <haiku|sonnet|opus> | autoStart <on|off> | autoInterval <minutes> | cleanWorktree|cleanBranch|cleanArchive <on|off>');
  writeAtomic(file, JSON.stringify(raw, null, 2) + '\n');
  console.log(`${key} = ${['autoStart', 'autoInterval', ...Object.values(CLEAN_KEYS)].includes(key) ? value : raw[key]}`);
  if (key === 'maxParallel') startNext(loadBoard(board.dir), { quiet: true });   // more room: start what waits
}

// Clean: always stops the agent; then, as the board's "clean" settings say (config cleanWorktree|cleanBranch|cleanArchive):
// removes the worktree, deletes the branch, moves the card to archived.
function cmdClean(board, [id]) {
  if (!id) die('usage: clean <id>   (stops its agent; removes the worktree, deletes the branch and archives the card as the board settings say)');
  const card = loadCard(board, id);
  const opt = board.clean;
  const name = termName(card.id);
  const repo = board.repos[card.meta.repo];
  const branch = card.meta.branch || `card/${card.id}`;
  const did = ['agent stopped'];
  hc(board, ['kill', name], { json: false, allowFail: true });
  hc(board, ['rm', name], { json: false, allowFail: true });
  if (opt.worktree && card.meta.worktree && existsSync(card.meta.worktree)) {
    try { git(['-C', repo.path, 'worktree', 'remove', card.meta.worktree]); }
    catch (e) { die(`${card.id}: worktree has uncommitted changes, left in place: ${card.meta.worktree}`); }
    did.push('worktree removed');
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
          catch (e2) { note = `branch ${branch} kept: ${String(e2.stderr || e2.message).trim().split('\n')[0]}`; }
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

// ---------- main ----------

const argv = process.argv.slice(2);
const boardDir = resolve(takeFlag(argv, '--board') || process.env.HERDR_BOARD || join(HERE, '..', 'board'));
const [cmd, ...rest] = argv;
const commands = {
  new: cmdNew, draft: cmdDraft, ls: cmdLs, plan: cmdPlan, approve: cmdApprove, next: (b) => startNext(b), start: cmdStart,
  answer: cmdAnswer, clean: cmdClean, save: cmdSave, config: cmdConfig, tick: cmdTick, where: cmdWhere, ask: cmdAsk, done: cmdDone,
};
if (!cmd || !commands[cmd]) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(4, 9).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(cmd ? 1 : 0);
}
try {
  commands[cmd](loadBoard(boardDir), rest);
} catch (e) {
  console.error(`herdr-board: ${e instanceof BoardError ? e.message : e.stack}`);
  process.exit(1);
}
