// The command line, run as a child process on a throwaway board (see helpers.mjs: no `hc`, no real board).
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tempBoard, cardText, ROOT } from './helpers.mjs';

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
});
