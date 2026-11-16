// The command line, run as a child process on a throwaway board (see helpers.mjs: no `hc`, no real board).
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, readdirSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tempBoard, cardText, ROOT, isolatedEnv } from './helpers.mjs';

process.env.HERDR_BOARD_NO_MAIN = '1';
const { parseCard, section } = await import('../herdr-board.mjs');

let b;
beforeEach(() => { b = tempBoard(); });
afterEach(() => { b.cleanup(); });
const card = (id) => parseCard(b.read(id));

describe('new (card numbering and template)', () => {
  test('the first card of a repo is <PREFIX>-1, from the template', () => {
    const r = b.run('new', 'app', 'First', 'card');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^TST-1 /);
    const text = b.read('TST-1');
    assert.doesNotMatch(text, /\{\{/);   // every placeholder filled
    const c = parseCard(text);
    assert.equal(c.meta.id, 'TST-1');
    assert.equal(c.meta.title, 'First card');
    assert.equal(c.meta.repo, 'app');
    assert.equal(c.meta.status, 'todo');
    assert.equal(c.meta.approved, 'false');
    assert.match(c.meta.created, /^\d{4}-\d\d-\d\d \d\d:\d\d$/);
    assert.match(section(c, 'Answers').body, /answer TST-1/);
  });

  test('numbers go on from the highest, as numbers, per prefix', () => {
    for (const id of ['TST-2', 'TST-9', 'TST-10', 'OTH-50']) b.write(id, cardText({ id, title: 'x', repo: 'app' }));
    writeFileSync(join(b.dir, 'cards', 'TST-99.md.bak'), 'not a card');
    assert.match(b.run('new', 'app', 'Next').out, /^TST-11 /);
    assert.match(b.run('new', 'app', 'Next again').out, /^TST-12 /);
    assert.match(b.run('new', 'other', 'Other repo').out, /^OTH-51 /);
  });

  test('the prefix defaults to the repo name in capitals', () => {
    writeFileSync(join(b.dir, 'board.json'), JSON.stringify({ worktrees: join(b.dir, 'wt'), repos: { web: { path: join(b.dir, 'r') } } }));
    assert.match(b.run('new', 'web', 'Hello').out, /^WEB-1 /);
  });

  test('creates the cards folder when missing', () => {
    rmSync(join(b.dir, 'cards'), { recursive: true });
    assert.equal(b.run('new', 'app', 'x').code, 0);
    assert.ok(existsSync(b.card('TST-1')));
  });

  test('refuses an unknown repo or a missing title', () => {
    const r = b.run('new', 'nope', 'Title');
    assert.equal(r.code, 1);
    assert.match(r.err, /unknown repo "nope"/);
    assert.match(b.run('new', 'app').err, /usage: new/);
    assert.deepEqual(readdirSync(join(b.dir, 'cards')), []);
  });

  test('--fields fills the card from the panel form', () => {
    const f = { done: 'merged', model: 'opus', effort: 'high', approved: true, context: 'The why.', constraints: '- None.', doneLooks: '- It works.' };
    const r = b.run('new', 'app', 'Form card', '--fields', encodeURIComponent(JSON.stringify(f)));
    assert.equal(r.code, 0, r.err);
    const c = card('TST-1');
    assert.equal(c.meta.done, 'merged');
    assert.equal(c.meta.model, 'opus');
    assert.equal(c.meta.effort, 'high');
    assert.equal(c.meta.approved, 'true');
    assert.equal(section(c, 'Context').body, 'The why.');
    assert.equal(section(c, 'Done looks like').body, '- It works.');
  });

  test('--fields-file never pre-approves a card', () => {
    const file = join(b.dir, 'fields.json');
    writeFileSync(file, JSON.stringify({ approved: true, context: 'From an agent.' }));
    assert.equal(b.run('new', 'app', 'Drafted', '--fields-file', file).code, 0);
    const c = card('TST-1');
    assert.equal(c.meta.approved, 'false');
    assert.equal(section(c, 'Context').body, 'From an agent.');
  });

  test('refuses a bad model, effort, or fields text, and writes no card', () => {
    const enc = (o) => encodeURIComponent(JSON.stringify(o));
    assert.match(b.run('new', 'app', 'x', '--fields', enc({ model: 'gpt' })).err, /model must be one of/);
    assert.match(b.run('new', 'app', 'x', '--fields', enc({ effort: 'huge' })).err, /effort must be one of/);
    assert.match(b.run('new', 'app', 'x', '--fields', '%7Bnot json').err, /not valid encoded JSON/);
    assert.match(b.run('new', 'app', 'x', '--fields-file', join(b.dir, 'missing.json')).err, /cannot read/);
    assert.deepEqual(readdirSync(join(b.dir, 'cards')), []);
  });
});

describe('done (--state and --pr)', () => {
  const running = (id = 'TST-1') => b.write(id, cardText({ id, title: 'Work', repo: 'app', status: 'running', done: 'merged' },
    '## Where we are\n\n- Goal: ship it\n- Done: half\n- Next: the rest\n'));

  test('without --state the outcome is reached', () => {
    running();
    const r = b.run('done', 'TST-1', 'All', 'good.');
    assert.equal(r.code, 0, r.err);
    const c = card('TST-1');
    assert.equal(c.meta.status, 'done');
    assert.equal(c.meta.outcome, 'reached');
    assert.match(c.meta.done_ms, /^\d+$/);
    assert.match(section(c, 'Result').body, /All good\.$/);
    assert.equal(section(c, 'Where we are').body, '- Goal: ship it\n- Done: half\n- Next: nothing, card done (see Result)');
    assert.match(section(c, 'Next action').body, /merged/);
    assert.equal(c.sections.find(s => s.title).title, 'Next action');   // first section of the card
  });

  test('each --state is kept as the outcome', () => {
    for (const state of ['reached', 'partial', 'blocked', 'failed', 'abandoned']) {
      running();
      const r = b.run('done', 'TST-1', '--state', state, 'Why.');
      assert.equal(r.code, 0, r.err);
      assert.equal(card('TST-1').meta.outcome, state);
    }
  });

  test('--state may come after the summary; the id is case-insensitive', () => {
    running();
    assert.equal(b.run('done', 'tst-1', 'Summary', '--state', 'partial').code, 0);
    const c = card('TST-1');
    assert.equal(c.meta.outcome, 'partial');
    assert.match(section(c, 'Result').body, /Summary$/);
  });

  test('--pr adds the pull request link to the Result', () => {
    running();
    assert.equal(b.run('done', 'TST-1', '--pr', 'https://github.com/o/r/pull/7', 'Shipped.').code, 0);
    assert.match(section(card('TST-1'), 'Result').body, /Shipped\.\n\nPull request: https:\/\/github\.com\/o\/r\/pull\/7$/);
  });

  test('refuses a bad or missing --state, a missing --pr link, or no summary, and leaves the card as it was', () => {
    running();
    const before = b.read('TST-1');
    const bad = b.run('done', 'TST-1', '--state', 'great', 'x');
    assert.equal(bad.code, 1);
    assert.match(bad.err, /--state must be one of reached, partial, blocked, failed, abandoned/);
    assert.match(b.run('done', 'TST-1', 'x', '--state').err, /--state needs a value/);
    assert.match(b.run('done', 'TST-1', 'x', '--pr').err, /--pr needs the pull request link/);
    assert.match(b.run('done', 'TST-1').err, /usage: done/);
    assert.match(b.run('done', 'TST-404', 'x').err, /no card TST-404/);
    assert.equal(b.read('TST-1'), before);
  });

  test('refuses an archived card', () => {
    b.write('TST-1', cardText({ id: 'TST-1', title: 'Old', repo: 'app', status: 'archived' }));
    const before = b.read('TST-1');
    assert.match(b.run('done', 'TST-1', 'late').err, /archived/);
    assert.equal(b.read('TST-1'), before);
  });

  test('a new done replaces the outcome remembered by a reopen', () => {
    b.write('TST-1', cardText({ id: 'TST-1', title: 'W', repo: 'app', status: 'running', reopened_outcome: 'partial', busy_ms: '1' }));
    assert.equal(b.run('done', 'TST-1', '--state', 'failed', 'No.').code, 0);
    const c = card('TST-1');
    assert.equal(c.meta.outcome, 'failed');
    assert.equal(c.meta.reopened_outcome, undefined);
    assert.equal(c.meta.busy_ms, undefined);
  });
});

describe('where and ask (the agent\'s other commands)', () => {
  test('where rewrites the three lines', () => {
    b.write('TST-1', cardText({ id: 'TST-1', title: 'W', repo: 'app', status: 'running' }));
    assert.equal(b.run('where', 'TST-1', 'The goal', 'Some done', 'Next step').code, 0);
    assert.equal(section(card('TST-1'), 'Where we are').body, '- Goal: The goal\n- Done: Some done\n- Next: Next step');
    assert.match(b.run('where', 'TST-1', 'only goal').err, /usage: where/);
  });

  test('ask puts the questions on the card and moves it to needs-you; a second ask keeps the first round in History', () => {
    b.write('TST-1', cardText({ id: 'TST-1', title: 'W', repo: 'app', status: 'running' }));
    assert.equal(b.run('ask', 'TST-1', 'First?', 'Second?').code, 0);
    let c = card('TST-1');
    assert.equal(c.meta.status, 'needs-you');
    assert.match(section(c, 'Questions').body, /1\. First\?\n2\. Second\?$/);
    assert.match(section(c, 'Next action').body, /answer the questions/);

    b.write('TST-1', b.read('TST-1').replace(/(## Answers\n\n[^\n]*\n)/, '$1\nUse A.\n'));
    assert.equal(b.run('ask', 'TST-1', 'Third?').code, 0);
    c = card('TST-1');
    assert.match(section(c, 'Questions').body, /1\. Third\?$/);
    assert.match(section(c, 'History').body, /First\?[\s\S]*Answers: Use A\./);
    assert.doesNotMatch(section(c, 'Answers').body, /Use A/);
  });
});

describe('ship-mark (the "shipping" label)', () => {
  const mark = (ev, id = 'TST-1') => {
    const r = spawnSync(process.execPath, [join(ROOT, 'herdr-board.mjs'), '--board', b.dir, 'ship-mark', id],
      { input: typeof ev === 'string' ? ev : JSON.stringify(ev), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout + r.stderr, '');
  };
  // a fake hc whose `ls` shows a working terminal for each card, so a running card stays in the Running column
  const shipping = (id = 'TST-1') => {
    const fake = join(b.dir, 'hc-ship.mjs');
    writeFileSync(fake, `console.log(process.argv[2] === 'ls' ? JSON.stringify({ terminals: [{ name: 'tst-1', status: 'working' }] }) : '{}');`);
    const r = spawnSync(process.execPath, [join(ROOT, 'herdr-board.mjs'), '--board', b.dir, 'ls', '--json'],
      { env: { ...isolatedEnv(), HERDR_BOARD_HC_SCRIPT: fake }, encoding: 'utf8' });
    return JSON.parse(r.stdout).cards.find(c => c.id === id).shipping;
  };
  const ship = { hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 'ship' } };
  const running = (id = 'TST-1') => b.write(id, cardText({ id, title: 'S', repo: 'app', status: 'running', active_ms: Date.now() }));

  test('the Skill tool starting /ship shows the label; the agent stopping hides it', () => {
    running();
    assert.equal(shipping(), false);
    mark(ship);
    assert.equal(shipping(), true);
    mark({ hook_event_name: 'Stop' });
    assert.equal(shipping(), false);
  });

  test('typing /ship starts it; the session ending (a failure, a kill) removes it', () => {
    running();
    mark({ hook_event_name: 'UserPromptSubmit', prompt: '/ship' });
    assert.equal(shipping(), true);
    mark({ hook_event_name: 'SessionEnd' });
    assert.equal(shipping(), false);
  });

  test('other skills, other prompts and other tools do not start it', () => {
    running();
    mark({ ...ship, tool_input: { skill: 'code-review' } });
    mark({ ...ship, tool_input: { skill: 'shipping-notes' } });
    mark({ ...ship, tool_name: 'Bash' });
    mark({ hook_event_name: 'UserPromptSubmit', prompt: 'please ship it' });
    mark({ hook_event_name: 'UserPromptSubmit', prompt: '/shipit' });
    assert.equal(shipping(), false);
  });

  test('done and ask remove it; so does a card that is no longer running', () => {
    running();
    mark(ship);
    assert.equal(b.run('ask', 'TST-1', 'Q?').code, 0);
    assert.equal(shipping(), false);
    running();
    assert.equal(shipping(), false);   // ask cleared the flag: it does not come back
    mark(ship);
    assert.equal(b.run('done', 'TST-1', 'ok').code, 0);
    assert.equal(shipping(), false);
    running();
    assert.equal(shipping(), false);
  });

  test('a flag left behind by a crash expires, and a card that stopped running does not show it', () => {
    running();
    mark(ship);
    b.write('TST-1', cardText({ id: 'TST-1', title: 'S', repo: 'app', status: 'needs-you' }));
    assert.equal(shipping(), false);
    running();
    writeFileSync(join(b.dir, '.shipping', 'TST-1.txt'), String(Date.now() - 4 * 3600 * 1000));
    assert.equal(shipping(), false);
  });

  test('never fails: bad input, an unknown card, no id', () => {
    mark('not json');
    mark(ship, 'NOPE-9');
    mark(ship, '');
    assert.equal(existsSync(join(b.dir, '.shipping', 'NOPE-9.txt')), false);
  });
});

describe('ls: archived order', () => {
  test('archived cards: newest close date first, undated last; other columns untouched', () => {
    const mk = (id, extra) => b.write(id, cardText({ id, title: id, repo: 'app', status: 'archived', ...extra }));
    mk('TST-1', { updated: '2026-11-10 09:00' });
    mk('TST-2', { done_ms: '5' });
    mk('TST-3', { updated: '2026-11-12 09:00' });
    mk('TST-4', { done_ms: '9' });
    b.write('TST-5', cardText({ id: 'TST-5', title: 'x', repo: 'app', status: 'todo' }));
    const j = JSON.parse(b.run('ls', '--json').out);
    assert.deepEqual(j.cards.filter(c => c.column === 'archived').map(c => c.id), ['TST-3', 'TST-1', 'TST-4', 'TST-2']);
  });
});

describe('card-creator skill: model and effort chosen at creation', () => {
  const skillFile = join(ROOT, 'skills', 'card-creator', 'SKILL.md');
  const skill = readFileSync(skillFile, 'utf8');

  test('the skill file has a name and a description, and uses the card format\'s names', () => {
    const head = skill.match(/^---\n([\s\S]*?)\n---\n/)?.[1] || '';
    assert.match(head, /^name: card-creator$/m);
    assert.match(head, /^description: .{20,}/m);
    for (const s of ['Context', 'Constraints', 'Done looks like']) assert.ok(readFileSync(join(ROOT, 'card-template.md'), 'utf8').includes(`## ${s}`), s);
    for (const f of ['context', 'constraints', 'doneLooks', 'done', 'model', 'effort']) assert.match(skill, new RegExp('`' + f + '`'), f);
    for (const t of ['none', 'local', 'local-reviewed', 'draft-pr', 'pr-ready', 'merged']) assert.match(skill, new RegExp('`' + t + '`'), t);
    for (const m of ['haiku', 'sonnet', 'opus']) assert.match(skill, new RegExp('`' + m + '`'), m);
    for (const e of ['low', 'medium', 'high', 'xhigh']) assert.match(skill, new RegExp('`' + e + '`'), e);
  });

  test('the skill\'s own JSON example makes a card with model and effort set, not approved', () => {
    const json = skill.match(/```json\r?\n([\s\S]*?)\r?\n\s*```/)?.[1];
    assert.ok(json, 'no json example in the skill');
    const file = join(b.dir, 'fields.json');
    writeFileSync(file, json);
    const r = b.run('new', 'app', 'From the skill', '--fields-file', file);
    assert.equal(r.code, 0, r.err);
    const c = card('TST-1');
    assert.ok(['haiku', 'sonnet', 'opus'].includes(c.meta.model), c.meta.model);
    assert.ok(['low', 'medium', 'high', 'xhigh'].includes(c.meta.effort), c.meta.effort);
    assert.equal(c.meta.approved, 'false');
    assert.doesNotMatch(b.read('TST-1'), /\{\{/);
  });

  test('approving a created card keeps its model and effort and skips the Auto choice', () => {
    const file = join(b.dir, 'fields.json');
    writeFileSync(file, JSON.stringify({ context: 'c', done: 'local', model: 'opus', effort: 'xhigh', approved: true }));
    assert.equal(b.run('new', 'app', 'Chosen', '--fields-file', file).code, 0);
    assert.equal(card('TST-1').meta.model, 'opus');
    assert.equal(card('TST-1').meta.effort, 'xhigh');
    const r = b.run('approve', 'TST-1');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /ready \(opus\/xhigh\)/);
    assert.equal(card('TST-1').meta.auto_choice, undefined);   // chooseAuto did not run
  });

  test('a hand-made card without a model still goes through the Auto choice', () => {
    assert.equal(b.run('new', 'app', 'By hand').code, 0);
    assert.equal(card('TST-1').meta.model, '');
    const r = b.run('approve', 'TST-1');   // `claude` is hidden in tests: the choice falls back to sonnet/medium
    assert.equal(r.code, 0, r.err);
    assert.match(card('TST-1').meta.auto_choice, /^Haiku choice failed/);
    assert.equal(card('TST-1').meta.model, 'sonnet');
    assert.equal(card('TST-1').meta.effort, 'medium');
  });

  test('update changes a Ready card', () => {
    assert.equal(b.run('new', 'app', 'Edit me').code, 0);
    assert.equal(b.run('approve', 'TST-1').code, 0);
    const hash = JSON.parse(b.run('show', 'TST-1').out).hash;
    const enc = encodeURIComponent(JSON.stringify({ title: 'Edited', done: 'local', model: 'sonnet', effort: 'medium', context: 'x' }));
    const r = b.run('update', 'TST-1', '--hash', hash, '--fields', enc);
    assert.equal(r.code, 0, r.err);
    assert.equal(card('TST-1').meta.title, 'Edited');
    assert.equal(card('TST-1').meta.status, 'ready');   // saving does not change the status
  });
});

describe('resume (archived cards)', () => {
  const SESSION = '11111111-2222-4333-8444-555555555555';
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' });
  // a real repo (no remote), a fake hc that logs what it is asked, and a fake Claude config folder
  function setup(extra = {}) {
    const repo = join(b.dir, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
    const board = JSON.parse(readFileSync(join(b.dir, 'board.json'), 'utf8'));
    board.repos.app.path = repo;
    writeFileSync(join(b.dir, 'board.json'), JSON.stringify(board));
    const log = join(b.dir, 'hc.log');
    const fake = join(b.dir, 'hc.mjs');
    writeFileSync(fake, `import {appendFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const c = process.argv[2];
console.log(c === 'ls' ? '{"terminals":[]}' : c === 'read' ? '❯ auto mode' : '{}');`);
    const claude = join(b.dir, 'claude-config');
    const run = (...args) => {
      const env = { ...process.env, HERDR_BOARD_HC_SCRIPT: fake, CLAUDE_CONFIG_DIR: claude };
      const r = spawnSync(process.execPath, [join(ROOT, 'herdr-board.mjs'), '--board', b.dir, ...args], { env, encoding: 'utf8' });
      return { code: r.status, out: r.stdout, err: r.stderr };
    };
    const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []);
    const wt = join(b.dir, 'worktrees', 'TST-1').replace(/\\/g, '/');
    const transcript = () => {
      const d = join(claude, 'projects', wt.replace(/[^A-Za-z0-9]/g, '-'));
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, `${SESSION}.jsonl`), '{}\n');
    };
    b.write('TST-1', cardText({ id: 'TST-1', title: 'Old', repo: 'app', status: 'archived', outcome: 'reached', model: 'sonnet', effort: 'medium', ...extra },
      '## Where we are\n\n- Goal: g\n- Done: d\n- Next: nothing\n'));
    return { repo, wt, run, calls, transcript };
  }

  test('start saves the session id it gives claude', () => {
    const s = setup({ status: 'ready', approved: 'true' });
    const r = s.run('start', 'TST-1');
    assert.equal(r.code, 0, r.err);
    const id = card('TST-1').meta.session;
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const run = s.calls().find(c => c[0] === 'run').join(' ');
    assert.match(run, new RegExp(`claude --session-id ${id} `));
  });

  test('start writes the /ship hooks into the worktree settings', () => {
    const s = setup({ status: 'ready', approved: 'true' });
    assert.equal(s.run('start', 'TST-1').code, 0);
    const cfg = JSON.parse(readFileSync(join(s.wt, '.claude', 'settings.local.json'), 'utf8'));
    for (const ev of ['PreToolUse', 'UserPromptSubmit', 'Stop', 'SessionEnd']) {
      assert.equal(cfg.hooks[ev].length, 1, ev);
      assert.match(cfg.hooks[ev][0].hooks[0].command, / ship-mark TST-1$/);
    }
    assert.equal(cfg.hooks.PreToolUse[0].matcher, 'Skill');
    assert.ok(cfg.permissions.allow.includes('Bash(gh pr create:*)'));
  });

  test('ls shows the saved session, and the Resume button is only added for archived cards', () => {
    b.write('TST-1', cardText({ id: 'TST-1', title: 'a', repo: 'app', status: 'archived', session: SESSION }));
    const j = JSON.parse(b.run('ls', '--json').out);
    assert.equal(j.cards[0].session, SESSION);
    assert.equal(j.cards[0].column, 'archived');
    const ui = readFileSync(join(ROOT, 'herdr-board', 'mods', 'herdr-board', 'main.js'), 'utf8');
    const resume = ui.split('\n').filter(l => /"Resume"/.test(l));
    assert.equal(resume.length, 1);
    assert.match(resume[0], /if \(c\.column === "archived"\)/);
  });

  test('only an archived card can be resumed', () => {
    b.write('TST-1', cardText({ id: 'TST-1', title: 'a', repo: 'app', status: 'done', session: SESSION }));
    const r = b.run('resume', 'TST-1');
    assert.equal(r.code, 1);
    assert.match(r.err, /only an archived card can be resumed/);
  });

  test('no saved session: a clear message', () => {
    const s = setup();
    const r = s.run('resume', 'TST-1');
    assert.equal(r.code, 1);
    assert.match(r.err, /no saved session/);
  });

  test('session saved but its conversation file is gone: a clear message', () => {
    const s = setup({ session: SESSION });
    assert.match(s.run('resume', 'TST-1').err, /conversation file .* is gone/);
  });

  test('branch gone locally and on origin: says so on the card, no worktree', () => {
    const s = setup({ session: SESSION });
    s.transcript();
    const r = s.run('resume', 'TST-1');
    assert.equal(r.code, 1);
    assert.match(r.err, /gone locally and on origin/);
    assert.equal(existsSync(s.wt), false);
    assert.match(section(card('TST-1'), 'Where we are').body, /cannot resume: branch card\/TST-1 is gone/);
    assert.equal(card('TST-1').meta.status, 'archived');
  });

  test('recreates the worktree from the local branch, resumes the session, card goes back to Done', () => {
    const s = setup({ session: SESSION });
    s.transcript();
    git(s.repo, 'branch', 'card/TST-1');
    const r = s.run('resume', 'TST-1');
    assert.equal(r.code, 0, r.err);
    assert.equal(existsSync(join(s.wt, '.git')), true);
    const run = s.calls().find(c => c[0] === 'run').join(' ');
    assert.match(run, new RegExp(`claude --resume ${SESSION} `));
    assert.match(run, /--cwd .*TST-1/);
    const c = card('TST-1');
    assert.equal(c.meta.status, 'done');
    assert.match(section(c, 'Where we are').body, /resumed from the archive/);
  });

  test('recreates the worktree from the remote branch when the local one is gone', () => {
    const s = setup({ session: SESSION });
    s.transcript();
    const origin = join(b.dir, 'origin.git');
    git(b.dir, 'init', '-q', '--bare', origin);
    git(s.repo, 'remote', 'add', 'origin', origin);
    git(s.repo, 'push', '-q', 'origin', 'main:card/TST-1');
    const r = s.run('resume', 'TST-1');
    assert.equal(r.code, 0, r.err);
    assert.equal(git(s.wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'card/TST-1');
  });

  test('never resumes into an existing worktree with uncommitted changes', () => {
    const s = setup({ session: SESSION });
    s.transcript();
    git(s.repo, 'branch', 'card/TST-1');
    git(s.repo, 'worktree', 'add', s.wt, 'card/TST-1');
    writeFileSync(join(s.wt, 'dirty.txt'), 'x');
    const r = s.run('resume', 'TST-1');
    assert.equal(r.code, 1);
    assert.match(r.err, /uncommitted changes/);
    assert.equal(s.calls().some(c => c[0] === 'run'), false);
    assert.equal(card('TST-1').meta.status, 'archived');
  });
});

describe('approve --start (Approve and start)', () => {
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' });
  // a real repo, and a fake hc: `ls` answers with the given running terminals, everything else is logged
  function setup(terminals = []) {
    const repo = join(b.dir, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
    const board = JSON.parse(readFileSync(join(b.dir, 'board.json'), 'utf8'));
    board.repos.app.path = repo;
    writeFileSync(join(b.dir, 'board.json'), JSON.stringify(board));
    const log = join(b.dir, 'hc.log');
    const fake = join(b.dir, 'hc.mjs');
    writeFileSync(fake, `import {appendFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const c = process.argv[2];
console.log(c === 'ls' ? ${JSON.stringify(JSON.stringify({ terminals }))} : c === 'read' ? '❯ auto mode' : '{}');`);
    const claude = join(b.dir, 'claude-config');
    const run = (...args) => {
      const env = { ...process.env, HERDR_BOARD_HC_SCRIPT: fake, CLAUDE_CONFIG_DIR: claude };
      const r = spawnSync(process.execPath, [join(ROOT, 'herdr-board.mjs'), '--board', b.dir, ...args], { env, encoding: 'utf8' });
      return { code: r.status, out: r.stdout, err: r.stderr };
    };
    const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []);
    return { run, calls };
  }
  const make = (id, extra = {}) => b.write(id, cardText({ id, title: id, repo: 'app', status: 'todo', model: 'sonnet', effort: 'medium', ...extra }));

  test('a free slot: the card is approved and running at once', () => {
    const s = setup();
    make('TST-1');
    const r = s.run('approve', 'TST-1', '--start');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /started as tst-1/);
    const c = card('TST-1');
    assert.equal(c.meta.status, 'running');
    assert.equal(c.meta.approved, 'true');
    assert.ok(c.meta.session);
    assert.ok(s.calls().some(a => a[0] === 'run'));
  });

  test('all slots taken (maxParallel): the card waits in Ready and nothing is launched', () => {
    const s = setup([{ name: 'tst-8', status: 'working' }, { name: 'tst-9', status: 'working' }]);
    make('TST-8', { status: 'running' });
    make('TST-9', { status: 'running' });
    make('TST-1');
    const r = s.run('approve', 'TST-1', '--start');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /all slots are taken/);
    assert.equal(card('TST-1').meta.status, 'ready');
    assert.equal(card('TST-1').meta.approved, 'true');
    assert.ok(!s.calls().some(a => a[0] === 'run'));
  });

  test('plain approve still only moves the card to Ready', () => {
    const s = setup();
    make('TST-1');
    assert.equal(s.run('approve', 'TST-1').code, 0);
    assert.equal(card('TST-1').meta.status, 'ready');
    assert.ok(!s.calls().some(a => a[0] === 'run'));
  });

  test('the panel has both the Approve and the Approve and start buttons on To do cards', () => {
    const ui = readFileSync(join(ROOT, 'herdr-board', 'mods', 'herdr-board', 'main.js'), 'utf8');
    const lines = ui.split('\n').filter(l => /c\.column === "todo"\) b\.push/.test(l));
    assert.equal(lines.length, 2);
    assert.ok(lines.some(l => /"Approve", .*\["approve", id\]/.test(l)));
    assert.ok(lines.some(l => /"Approve and start", .*\["approve", id, "--start"\]/.test(l)));
  });
});

describe('add-repo / remove-repo / suggest-repos', () => {
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
  // these run git for real, so they keep the PATH (the other tests hide it)
  const run = (...args) => {
    const r = spawnSync(process.execPath, [join(ROOT, 'herdr-board.mjs'), '--board', b.dir, ...args], { env: { ...process.env, HERDR_BOARD_HC_SCRIPT: '' }, encoding: 'utf8' });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const mkRepo = (name, branch = 'main') => {
    const dir = join(b.dir, 'repos', name);
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', branch);
    git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
    return dir.split('\\').join('/');
  };
  const boardJson = () => JSON.parse(readFileSync(join(b.dir, 'board.json'), 'utf8'));

  test('adds a repo with a prefix from its name, its base branch and a new color', () => {
    const dir = mkRepo('herdr-git-graph');
    const r = run('add-repo', 'herdr-git-graph', dir);
    assert.equal(r.code, 0, r.err);
    const e = boardJson().repos['herdr-git-graph'];
    assert.equal(e.path, dir);
    assert.equal(e.prefix, 'HGG');
    assert.equal(e.base, 'main');
    assert.match(e.color, /^#[0-9a-f]{6}$/);
    assert.equal(run('new', 'herdr-git-graph', 'First').out.slice(0, 6), 'HGG-1 ');   // usable at once
  });

  test('a single word gives its first letters; a taken prefix gets longer', () => {
    assert.equal(run('add-repo', 'shepherdr', mkRepo('shepherdr', 'master')).code, 0);
    assert.equal(boardJson().repos.shepherdr.prefix, 'SHE');
    assert.equal(boardJson().repos.shepherdr.base, 'master');
    assert.equal(run('add-repo', 'shelf', mkRepo('shelf')).code, 0);
    assert.equal(boardJson().repos.shelf.prefix, 'SHEL');
  });

  test('--prefix, --base and --color override the defaults', () => {
    const xdir = mkRepo('x');
    const r = run('add-repo', 'x', xdir, '--prefix', 'zz', '--base', 'develop', '--color', '#ABCDEF', '--json');
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(boardJson().repos.x, { path: xdir, prefix: 'ZZ', base: 'develop', color: '#abcdef' });
    assert.equal(JSON.parse(r.out).prefix, 'ZZ');
  });

  test('keeps the fields and settings of board.json it does not know', () => {
    const j = boardJson();
    j.custom = { keep: ['me'] };
    j.repos.app.extra = 'stay';
    writeFileSync(join(b.dir, 'board.json'), JSON.stringify(j));
    assert.equal(run('add-repo', 'newone', mkRepo('newone')).code, 0);
    const after = boardJson();
    assert.deepEqual(after.custom, { keep: ['me'] });
    assert.equal(after.repos.app.extra, 'stay');
    assert.equal(run('remove-repo', 'newone').code, 0);
    assert.deepEqual(boardJson(), j);
  });

  test('refuses what cannot work', () => {
    const dir = mkRepo('r1');
    assert.match(run('add-repo', 'r1').err, /usage: add-repo/);
    assert.match(run('add-repo', 'app', dir).err, /already on the board/);
    assert.match(run('add-repo', 'bad name', dir).err, /not a usable repo name/);
    assert.match(run('add-repo', 'r1', join(b.dir, 'nope')).err, /not a git repo/);
    mkdirSync(join(b.dir, 'plain'));
    assert.match(run('add-repo', 'r1', join(b.dir, 'plain')).err, /not a git repo/);
    assert.match(run('add-repo', 'r1', dir, '--prefix', 'TST').err, /prefix TST is already used/);
    assert.match(run('add-repo', 'r1', dir, '--color', 'red').err, /color must/);
    assert.equal(run('add-repo', 'r1', dir).code, 0);
    assert.match(run('add-repo', 'r2', dir).err, /already on the board as "r1"/);   // the same folder twice
    assert.deepEqual(Object.keys(boardJson().repos), ['app', 'other', 'r1']);
  });

  test('a worktree path adds the repo it belongs to', () => {
    const dir = mkRepo('main-repo');
    const wt = join(b.dir, 'a-worktree').split('\\').join('/');
    git(dir, 'worktree', 'add', '-q', '-b', 'side', wt);
    assert.equal(run('add-repo', 'main-repo', wt).code, 0);
    assert.equal(boardJson().repos['main-repo'].path, dir);
  });

  test('remove-repo drops only the entry, and refuses while a card still uses it', () => {
    const dir = mkRepo('gone');
    run('add-repo', 'gone', dir);
    b.write('GON-1', cardText({ id: 'GON-1', title: 'x', repo: 'gone', status: 'done' }));
    const r = run('remove-repo', 'gone');
    assert.equal(r.code, 1);
    assert.match(r.err, /cannot remove "gone".*GON-1/);
    assert.ok(boardJson().repos.gone);
    b.write('GON-1', cardText({ id: 'GON-1', title: 'x', repo: 'gone', status: 'archived' }));
    const ok = run('remove-repo', 'gone');
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.out, /untouched.*1 archived card/);
    assert.equal(boardJson().repos.gone, undefined);
    assert.ok(existsSync(dir));          // the folder
    assert.ok(existsSync(b.card('GON-1')));   // and the card stay
    assert.match(run('remove-repo', 'gone').err, /unknown repo "gone"/);
    assert.match(run('remove-repo').err, /usage: remove-repo/);
  });

  test('suggest-repos lists git folders not on the board, once each, worktrees folded into their repo', () => {
    const known = mkRepo('known');
    const j = boardJson(); j.repos.app.path = known; writeFileSync(join(b.dir, 'board.json'), JSON.stringify(j));
    const fresh = mkRepo('fresh-one');
    const wt = join(b.dir, 'fresh-wt').split('\\').join('/');
    git(fresh, 'worktree', 'add', '-q', '-b', 'side', wt);
    mkdirSync(join(b.dir, 'plain'));
    const r = run('suggest-repos', known, fresh, wt, join(b.dir, 'plain'), join(b.dir, 'missing'));
    assert.equal(r.code, 0, r.err);
    const list = JSON.parse(r.out);
    assert.equal(list.length, 1);
    assert.deepEqual({ name: list[0].name, path: list[0].path, prefix: list[0].prefix, base: list[0].base }, { name: 'fresh-one', path: fresh, prefix: 'FO', base: 'main' });
    assert.deepEqual(boardJson().repos.app.path, known);   // nothing was added
    assert.equal(Object.keys(boardJson().repos).length, 2);
  });
});

describe('add-repo / remove-repo: edge cases', () => {
  const run = (...args) => {
    const r = spawnSync(process.execPath, [join(ROOT, 'herdr-board.mjs'), '--board', b.dir, ...args], { env: { ...process.env, HERDR_BOARD_HC_SCRIPT: '' }, encoding: 'utf8' });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const mk = (name) => {
    const dir = join(b.dir, 'repos', name);
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    return dir;
  };

  test('a flag with no value, or a base that looks like an option, is refused', () => {
    const dir = mk('e1');
    assert.match(run('add-repo', 'e1', dir, '--prefix').err, /--prefix needs a value/);
    assert.match(run('add-repo', 'e1', dir, '--base', '-x').err, /not a usable branch name/);
    assert.equal(Object.keys(JSON.parse(readFileSync(join(b.dir, 'board.json'), 'utf8')).repos).length, 2);
  });

  test('remove-repo refuses when a card file cannot be read (it cannot tell who uses the repo)', () => {
    run('add-repo', 'e2', mk('e2'));
    writeFileSync(join(b.dir, 'cards', 'E2-1.md'), 'not a card');
    const r = run('remove-repo', 'e2');
    assert.equal(r.code, 1);
    assert.match(r.err, /unreadable card file/);
    assert.ok(JSON.parse(readFileSync(join(b.dir, 'board.json'), 'utf8')).repos.e2);
  });
});

describe('init and version', () => {
  const fresh = () => join(b.dir, 'new-board');
  const runFree = (...args) => {   // no --board: there is no board yet
    const r = spawnSync(process.execPath, [join(ROOT, 'herdr-board.mjs'), ...args], { env: isolatedEnv(), encoding: 'utf8' });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };

  test('init makes board.json and cards/, and the board then works', () => {
    const r = runFree('init', fresh());
    assert.equal(r.code, 0, r.err);
    assert.ok(existsSync(join(fresh(), 'cards')));
    const j = JSON.parse(readFileSync(join(fresh(), 'board.json'), 'utf8'));
    assert.equal(j.name, 'new-board');
    assert.equal(j.maxParallel, 2);
    assert.match(j.worktrees, /new-board\/worktrees$/);
    assert.deepEqual(j.repos, {});
    const ls = spawnSync(process.execPath, [join(ROOT, 'herdr-board.mjs'), '--board', fresh(), 'ls', '--json'], { env: isolatedEnv(), encoding: 'utf8' });
    assert.equal(ls.status, 0, ls.stderr);
    assert.deepEqual(JSON.parse(ls.stdout).cards, []);
  });

  test('init makes missing parent folders and takes --name and --worktrees', () => {
    const dir = join(fresh(), 'a', 'b');
    const r = runFree('init', dir, '--name', 'Payments', '--worktrees', join(b.dir, 'wt'));
    assert.equal(r.code, 0, r.err);
    const j = JSON.parse(readFileSync(join(dir, 'board.json'), 'utf8'));
    assert.equal(j.name, 'Payments');
    assert.match(j.worktrees, /\/wt$/);
  });

  test('init refuses an existing board.json and leaves it as it was', () => {
    const before = readFileSync(join(b.dir, 'board.json'), 'utf8');
    const r = runFree('init', b.dir);
    assert.equal(r.code, 1);
    assert.match(r.err, /already holds a board/);
    assert.equal(readFileSync(join(b.dir, 'board.json'), 'utf8'), before);
  });

  test('init needs a folder', () => {
    const r = runFree('init');
    assert.equal(r.code, 1);
    assert.match(r.err, /usage: init <folder>/);
  });

  test('version prints the id of this copy, the same one ls --json reports, with or without a board', () => {
    const v = runFree('version');
    assert.equal(v.code, 0, v.err);
    assert.match(v.out.trim(), /^[0-9a-f]+$/);
    assert.equal(JSON.parse(b.run('ls', '--json').out).cli, v.out.trim());
    assert.equal(b.run('version').out.trim(), v.out.trim());
  });
});

describe('init: bad arguments and version', () => {
  const free = (...args) => spawnSync(process.execPath, [join(ROOT, 'herdr-board.mjs'), ...args], { env: isolatedEnv(), encoding: 'utf8' });
  test('a flag without a value, or a second folder, is a usage error and makes nothing', () => {
    const dir = join(b.dir, 'x');
    for (const a of [[dir, '--name', '--worktrees', 'w'], [dir, 'other'], ['--name', 'N']]) {
      const r = free('init', ...a);
      assert.equal(r.status, 1, a.join(' '));
      assert.match(r.stderr, /usage: init/);
    }
    assert.ok(!existsSync(dir));
  });
  test('a folder that cannot be made is a one-line error', () => {
    const r = free('init', join(b.dir, 'board.json', 'sub'));   // a file in the way
    assert.equal(r.status, 1);
    assert.match(r.stderr, /cannot create the board/);
    assert.doesNotMatch(r.stderr, /\n\s+at /);
  });
  test('the version also covers the other files deploy.sh copies', () => {
    assert.match(readFileSync(join(ROOT, 'deploy.sh'), 'utf8'), /herdr-board\.mjs check\.mjs rules\.md draft-rules\.md card-template\.md/);
  });
});
