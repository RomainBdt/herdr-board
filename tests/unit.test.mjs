// The card logic, called directly: parsing, the template fields, the status / column rules.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, NO_PATH } from './helpers.mjs';

process.env.HERDR_BOARD_NO_MAIN = '1';   // import the functions without running the command line
process.env.PATH = NO_PATH;              // no `hc` here: display() may look for a terminal, it must find none
delete process.env.HC_SESSION;
const hb = await import('../herdr-board.mjs');
const TEMPLATE = readFileSync(join(ROOT, 'card-template.md'), 'utf8');

const meta = (m) => Object.entries(m).map(([k, v]) => `${k}: ${v}`).join('\n');

describe('parseCard', () => {
  test('reads the front matter and the sections in order', () => {
    const c = hb.parseCard('---\nid: TST-1\ntitle: A card\n---\n\nintro\n\n## Context\n\nSome text.\n\n## Questions\n');
    assert.deepEqual(c.meta, { id: 'TST-1', title: 'A card' });
    assert.deepEqual(c.sections.map(s => s.title), ['', 'Context', 'Questions']);
    assert.equal(c.sections[0].body, 'intro');
    assert.equal(c.sections[1].body, 'Some text.');
    assert.equal(c.sections[2].body, '');
  });

  test('accepts Windows line endings', () => {
    const c = hb.parseCard('---\r\nid: TST-2\r\nstatus: todo\r\n---\r\n\r\n## Context\r\n\r\nline one\r\nline two\r\n');
    assert.equal(c.meta.status, 'todo');
    assert.equal(hb.section(c, 'context').body, 'line one\nline two');
  });

  test('drops "  # hint" comments but keeps a # inside a value', () => {
    const c = hb.parseCard('---\ndone: pr-ready        # none | local\ntitle: Fix #12 and #13\nmodel:      # haiku\n---\n');
    assert.equal(c.meta.done, 'pr-ready');
    assert.equal(c.meta.title, 'Fix #12 and #13');
    assert.equal(c.meta.model, '');
  });

  test('unquotes quoted values and keeps colons in values', () => {
    const c = hb.parseCard('---\ntitle: "Quoted: yes"\nother: \'single\'\nurl: https://x.y/z\n---\n');
    assert.equal(c.meta.title, 'Quoted: yes');
    assert.equal(c.meta.other, 'single');
    assert.equal(c.meta.url, 'https://x.y/z');
  });

  test('refuses text without front matter', () => {
    assert.throws(() => hb.parseCard('## Context\n\nno front matter'), /front matter/);
  });

  test('renderCard gives back the same card', () => {
    const text = '---\nid: TST-3\nstatus: done\n---\n\nintro\n\n## Context\n\nA\nB\n\n## Questions\n';
    const c = hb.parseCard(text);
    assert.equal(hb.renderCard(c), text);
    assert.deepEqual(hb.parseCard(hb.renderCard(c)), c);
  });

  test('the card template parses, with its defaults', () => {
    const c = hb.parseCard(TEMPLATE);
    assert.equal(c.meta.status, 'todo');
    assert.equal(c.meta.done, 'pr-ready');
    assert.equal(c.meta.approved, 'false');
    assert.equal(c.meta.model, '');
    for (const s of ['Context', 'Constraints', 'Done looks like', 'Where we are', 'Questions', 'Answers']) assert.ok(hb.section(c, s), s);
  });
});

describe('applyFields', () => {
  test('empty fields keep the template as it is', () => {
    assert.equal(hb.applyFields(TEMPLATE, {}), TEMPLATE);
    assert.equal(hb.applyFields(TEMPLATE, { done: '', model: ' ', context: '\n', approved: false }), TEMPLATE);
  });

  test('fills the front matter and the three sections', () => {
    const out = hb.applyFields(TEMPLATE, {
      done: 'merged', model: 'opus', effort: 'high', approved: true,
      context: 'Why: because.', constraints: '- Do not touch X.', doneLooks: '- Tests pass.',
    });
    const c = hb.parseCard(out);
    assert.equal(c.meta.done, 'merged');
    assert.equal(c.meta.model, 'opus');
    assert.equal(c.meta.effort, 'high');
    assert.equal(c.meta.approved, 'true');
    assert.equal(hb.section(c, 'Context').body, 'Why: because.');
    assert.equal(hb.section(c, 'Constraints').body, '- Do not touch X.');
    assert.equal(hb.section(c, 'Done looks like').body, '- Tests pass.');
    assert.equal(hb.section(c, 'Where we are').body, '_The agent keeps this up to date._');   // untouched
  });

  test('a front matter value stays on one line', () => {
    const c = hb.parseCard(hb.applyFields(TEMPLATE, { done: 'open a PR\r\nthen wait' }));
    assert.equal(c.meta.done, 'open a PR then wait');
    assert.equal(c.meta.model, '');   // the next key is still there
  });

  test('text with $ patterns is inserted as written', () => {
    const c = hb.parseCard(hb.applyFields(TEMPLATE, { context: 'cost $& and $1 and $$', done: 'pay $&' }));
    assert.equal(hb.section(c, 'Context').body, 'cost $& and $1 and $$');
    assert.equal(c.meta.done, 'pay $&');
  });

  test('a multi-line section keeps its lines, the next section is still filled', () => {
    const c = hb.parseCard(hb.applyFields(TEMPLATE, { context: 'line 1\n\nline 3', constraints: 'C' }));
    assert.equal(hb.section(c, 'Context').body, 'line 1\n\nline 3');
    assert.equal(hb.section(c, 'Constraints').body, 'C');
  });
});

describe('where / questions / answers', () => {
  test('whereOf reads the three lines', () => {
    const c = hb.parseCard('---\nid: TST-1\n---\n\n## Where we are\n\n- Goal: g one\n- **Done**: d\n* next:  n  \n');
    assert.deepEqual(hb.whereOf(c), { goal: 'g one', done: 'd', next: 'n' });
    assert.deepEqual(hb.whereOf(hb.parseCard('---\nid: x\n---\n')), { goal: '', done: '', next: '' });
  });

  test('questionsOf lists the numbered questions only', () => {
    const c = hb.parseCard('---\nid: TST-1\n---\n\n## Questions\n\n_Asked 2026-01-01 10:00_\n\n1. First?\n2) Second?\nnot a question\n');
    assert.deepEqual(hb.questionsOf(c), ['First?', 'Second?']);
  });

  test('answersOf skips the italic hint and timestamps', () => {
    const c = hb.parseCard('---\nid: TST-1\n---\n\n## Answers\n\n_Write your answers here, then run `answer TST-1`._\n\n_2026-01-01 10:00_\nUse option A.\n');
    assert.equal(hb.answersOf(c), 'Use option A.');
  });
});

describe('nextActionOf (from the status and the done target)', () => {
  const card = (m, body = '') => ({ id: 'TST-1', ...hb.parseCard(`---\n${meta(m)}\n---\n\n${body}`) });

  test('todo: approve, unless pre-approved', () => {
    assert.match(hb.nextActionOf(card({ status: 'todo' })), /approve the card \(`approve TST-1`\)/);
    assert.match(hb.nextActionOf(card({ title: 'no status means todo' })), /approve the card/);
    assert.match(hb.nextActionOf(card({ status: 'todo', approved: 'true' })), /^Nothing: waiting/);
  });

  test('ready and running: nothing for the person', () => {
    assert.match(hb.nextActionOf(card({ status: 'ready' })), /^Nothing: approved/);
    assert.match(hb.nextActionOf(card({ status: 'running' })), /^Nothing: the agent is working/);
  });

  test('needs-you: answer the questions, or check a stopped agent', () => {
    assert.match(hb.nextActionOf(card({ status: 'needs-you' }, '## Questions\n\n1. Which?\n')), /answer the questions/);
    assert.match(hb.nextActionOf(card({ status: 'needs-you' })), /stopped without asking/);
  });

  test('done: one line per done target', () => {
    const at = (done) => hb.nextActionOf(card({ status: 'done', done }));
    assert.match(at('none'), /No git changes/);
    assert.match(at('local'), /branch `card\/TST-1`/);
    assert.match(hb.nextActionOf(card({ status: 'done', done: 'local', branch: 'feat/x' })), /branch `feat\/x`/);
    assert.match(at('local-reviewed'), /self-reviewed/);
    assert.match(at('draft-pr'), /draft pull request/);
    assert.match(at('pr-ready'), /review the pull request/);
    assert.match(at('merged'), /is merged/);
    assert.match(at('deploy it to staging'), /target: deploy it to staging/);
  });

  test('archived: no next action', () => {
    assert.equal(hb.nextActionOf(card({ status: 'archived' })), '');
  });
});

describe('display (the column a card shows in)', () => {
  const board = { dir: 'unused', repos: {} };
  const card = (m) => ({ id: 'TST-1', meta: m, sections: [] });
  const live = (status) => ({ 'tst-1': { name: 'tst-1', status } });
  const stale = String(Date.now() - 10 * 60000);

  test('a card that is not running shows in its own column', () => {
    for (const s of ['todo', 'ready', 'needs-you', 'done', 'archived']) assert.deepEqual(hb.display(card({ status: s }), {}, board), { column: s, note: '' });
    assert.equal(hb.display(card({}), {}, board).column, 'todo');
  });

  test('a card that failed to start needs the person', () => {
    assert.deepEqual(hb.display(card({ status: 'ready', start_error: 'no repo' }), {}, board), { column: 'needs-you', note: 'could not start: no repo' });
    // once running, the old error no longer counts
    assert.equal(hb.display(card({ status: 'running', start_error: 'old', active_ms: stale }), live('working'), board).column, 'running');
  });

  test('running with a busy agent stays running', () => {
    assert.equal(hb.display(card({ status: 'running', active_ms: stale }), live('working'), board).column, 'running');
  });

  test('running without a terminal, blocked, or errored needs the person', () => {
    assert.deepEqual(hb.display(card({ status: 'running' }), {}, board), { column: 'needs-you', note: 'agent stopped (no terminal)' });
    assert.match(hb.display(card({ status: 'running' }), live('blocked'), board).note, /waiting on a prompt/);
    assert.match(hb.display(card({ status: 'running' }), live('error'), board).note, /error/);
  });

  test('an idle agent: running while fresh, needs the person once stale', () => {
    assert.equal(hb.display(card({ status: 'running', active_ms: String(Date.now()) }), live('idle'), board).column, 'running');
    const old = hb.display(card({ status: 'running', active_ms: stale }), live('idle'), board);
    assert.equal(old.column, 'needs-you');
    assert.match(old.note, /stopped without asking or finishing/);
    assert.equal(hb.display(card({ status: 'running', active_ms: stale }), live('done'), board).column, 'needs-you');
  });
});

describe('small helpers', () => {
  test('termName makes a terminal name from a card id', () => {
    assert.equal(hb.termName('HB-43'), 'hb-43');
    assert.equal(hb.termName('A B/C'), 'a-b-c');
    assert.equal(hb.termName('X'.repeat(40)).length, 32);
  });

  test('autoInterval accepts 1 to 1440 minutes, else 5', () => {
    assert.equal(hb.autoInterval(10), 10);
    assert.equal(hb.autoInterval('1440'), 1440);
    for (const v of [0, 1441, 'x', undefined, null]) assert.equal(hb.autoInterval(v), 5, String(v));
  });

  test('clip keeps the end of a long message', () => {
    assert.equal(hb.clip('  a \n b  '), 'a b');
    const c = hb.clip('x'.repeat(500) + ' THE END');
    assert.ok(c.startsWith('…') && c.endsWith('THE END') && c.length <= 300, c);
  });
});

describe('rules.md: merged target', () => {
  const rules = readFileSync(join(ROOT, 'rules.md'), 'utf8');
  const merged = rules.split(/\r?\n- `/).find(l => l.startsWith('merged`'));
  test('deletes only the card\'s own remote branch, after a successful merge', () => {
    assert.match(merged, /git push origin --delete card\/\{\{id\}\}/);
    assert.match(merged, /after a successful merge/);
    assert.match(merged, /If the merge failed or did not happen, leave the branch alone/);
    assert.equal((rules.match(/--delete/g) || []).length, 1);   // no other target deletes a branch
  });
});
