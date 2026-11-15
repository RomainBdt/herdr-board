// The board layout: what install.sh writes into Herdr (layout/merge-layout.mjs), and the panel blocks the tab bar reads.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './helpers.mjs';
import { mergeLayout, installLayout, findNode } from '../layout/merge-layout.mjs';

const REPO_PATH = join(ROOT, 'layout', 'board.json');
const REPO_TEXT = readFileSync(REPO_PATH, 'utf8');
const repo = () => JSON.parse(REPO_TEXT);
const panelIds = (layout) => findNode(layout, 'panel-body').children.map(c => c.id);
const extra = (id, props) => ({ id, type: 'block', content: { mod: `my-${id}`, ...(props ? { props } : {}) } });
// The repo layout as an older install had it, with blocks added to its panel-body.
function installedWith(...blocks) {
  const old = repo();
  const body = findNode(old, 'panel-body');
  for (const c of body.children) delete c.content.props;
  body.children.push(...blocks);
  return old;
}

describe('the repo layout', () => {
  test('panel-body is a stack of Files and Changes, each with a label and an icon', () => {
    const body = findNode(repo(), 'panel-body');
    assert.equal(body.type, 'stack');
    assert.deepEqual(body.children.map(c => [c.id, c.content.mod, c.content.props.label, c.content.props.icon]), [
      ['files', 'files', 'Files', 'mods/files/file.svg'],
      ['changes', 'changes', 'Changes', 'mods/changes/changes.svg'],
    ]);
  });

  test('has the nodes the tab bar uses', () => {
    for (const id of ['tabs', 'panel', 'panel-body', 'board-side', 'board-top']) assert.ok(findNode(repo(), id), id);
  });
});

describe('mergeLayout', () => {
  test('keeps the blocks added to panel-body, after the repo ones, in their order', () => {
    const { layout, kept } = mergeLayout(repo(), installedWith(extra('one', { label: 'One', icon: 'mods/my-one/i.svg' }), extra('two')));
    assert.deepEqual(kept, ['one', 'two']);
    assert.deepEqual(panelIds(layout), ['files', 'changes', 'one', 'two']);
    assert.deepEqual(findNode(layout, 'one'), extra('one', { label: 'One', icon: 'mods/my-one/i.svg' }));
  });

  test('the repo version of its own blocks wins, and the rest of the layout is the repo one', () => {
    const old = installedWith(extra('one'));
    old.children[0].size = { px: 999 };
    findNode(old, 'panel-body').active = 'one';
    const { layout } = mergeLayout(repo(), old);
    const want = repo();
    findNode(want, 'panel-body').children.push(extra('one'));
    assert.deepEqual(layout, want);
  });

  test('nothing added: the repo layout as it is', () => {
    assert.deepEqual(mergeLayout(repo(), repo()), { layout: repo(), kept: [] });
    assert.deepEqual(mergeLayout(repo(), installedWith()).kept, []);
  });

  test('a block whose id the repo layout already uses elsewhere, or twice, or without an id, is dropped', () => {
    const { layout, kept } = mergeLayout(repo(), installedWith(extra('tabs'), extra('one'), extra('one'), { type: 'block' }, null));
    assert.deepEqual(kept, ['one']);
    assert.deepEqual(panelIds(layout), ['files', 'changes', 'one']);
  });

  test('a block holding an id the repo layout already uses is dropped', () => {
    const nested = { id: 'extras', type: 'stack', children: [extra('files')] };
    const { layout, kept } = mergeLayout(repo(), installedWith(nested, extra('one')));
    assert.deepEqual(kept, ['one']);
    assert.deepEqual(panelIds(layout), ['files', 'changes', 'one']);
  });

  test('an installed layout without a panel-body changes nothing', () => {
    assert.deepEqual(mergeLayout(repo(), { id: 'root', type: 'row', children: [] }), { layout: repo(), kept: [] });
    assert.deepEqual(mergeLayout(repo(), null), { layout: repo(), kept: [] });
  });

  test('changes neither input', () => {
    const r = repo(), old = installedWith(extra('one'));
    const before = [JSON.stringify(r), JSON.stringify(old)];
    mergeLayout(r, old);
    assert.deepEqual([JSON.stringify(r), JSON.stringify(old)], before);
  });
});

describe('installLayout (the file install.sh writes)', () => {
  const withDir = (fn) => {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-board-layout-'));
    try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  };

  test('no installed layout: the repo file, byte for byte', () => withDir(dir => {
    const out = join(dir, 'board.json');
    assert.deepEqual(installLayout(REPO_PATH, out), { kept: [], warning: null });
    assert.equal(readFileSync(out, 'utf8'), REPO_TEXT);
  }));

  test('run twice, the added block is still there once', () => withDir(dir => {
    const out = join(dir, 'board.json');
    writeFileSync(out, JSON.stringify(installedWith(extra('one'))));
    assert.deepEqual(installLayout(REPO_PATH, out).kept, ['one']);
    assert.deepEqual(installLayout(REPO_PATH, out).kept, ['one']);
    assert.deepEqual(panelIds(JSON.parse(readFileSync(out, 'utf8'))), ['files', 'changes', 'one']);
    assert.deepEqual(readdirSync(dir), ['board.json']);   // no temp file left behind
  }));

  test('an installed layout that is not JSON: replaced, with a warning, the old file set aside, a .bak untouched', () => withDir(dir => {
    const out = join(dir, 'board.json');
    writeFileSync(out, '{ not json');
    writeFileSync(`${out}.bak`, 'my own backup');
    const { kept, warning } = installLayout(REPO_PATH, out);
    assert.deepEqual(kept, []);
    assert.match(warning, /not valid JSON/);
    assert.equal(readFileSync(out, 'utf8'), REPO_TEXT);
    assert.equal(readFileSync(`${out}.bak`, 'utf8'), 'my own backup');
    const aside = readdirSync(dir).filter(f => f.startsWith('board.json.invalid-'));
    assert.equal(aside.length, 1);
    assert.equal(readFileSync(join(dir, aside[0]), 'utf8'), '{ not json');
    assert.match(warning, new RegExp(aside[0]));
  }));

  test('the command line prints the kept panels', () => withDir(dir => {
    const out = join(dir, 'board.json');
    writeFileSync(out, JSON.stringify(installedWith(extra('one'))));
    const r = spawnSync(process.execPath, [join(ROOT, 'layout', 'merge-layout.mjs'), REPO_PATH, out], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /kept your panels in the layout: one/);
  }));
});

describe('the tab bar mod', () => {
  const src = readFileSync(join(ROOT, 'herdr-board', 'mods', 'herdr-board-tabs', 'main.js'), 'utf8');

  test('builds its panel buttons from panel-body, with no panel label or icon written in', () => {
    assert.match(src, /find\(root, "panel-body"\)\?\.children/);
    assert.doesNotMatch(src, /"Files"|"Changes"|file\.svg|changes\.svg/);
  });

  test('keeps the board toggle command and sends any other command to the panel with that id', () => {
    assert.match(src, /c === "toggle"\) toggleBoard\(\); else togglePanel\(c\)/);
  });
});
