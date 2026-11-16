// The panel's settings dialog, run for real against stand-ins for Herdr's modules (no GPUI here).
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';

// What the stand-ins hold; each test sets it up again.
const world = { shared: {}, machines: [], props: {}, execs: [], lsJson: '{}' };
const input = ({ value = '' } = {}) => {
  let v = value; const on = {};
  return { value: () => v, set_value: (x) => { v = x; }, on: (e, f) => { on[e] = f; } };
};
// a chain that ignores every call (the rendering API): .a().b().c() always gives it back
const chain = () => new Proxy(function () {}, { get: () => chain(), apply: () => chain() });
globalThis.__herdr = {
  gpuiKit: { View: class {}, div: chain },
  gpuiBase: { v_flex: chain, h_flex: chain, InputState: { new: input }, Input: { new: chain }, EditorState: {}, Editor: {}, TextareaState: {}, Textarea: {} },
  herdr: {
    exec: async (cmd, args, o) => { world.execs.push({ cmd, args, on: o?.on }); return world.exec ? world.exec(o ?? {}) : { code: 0, stdout: world.lsJson, stderr: '' }; },
    run() {}, props: () => world.props, theme: () => chain(), settings: () => ({}), notify() {}, playSound() {}, openOverlay() {}, closeOverlay() {},
    readTextFile: async () => '', shared: (k) => world.shared[k], setShared: (k, v) => { world.shared[k] = v; },
    agents: () => [], nextCommand: () => new Promise(() => {}), layout: () => ({}), machines: () => world.machines, spaces: () => [], panes: () => [],
  },
};

// main.js with its imports pointed at the stand-ins above
const src = readFileSync(join(ROOT, 'herdr-board', 'mods', 'herdr-board', 'main.js'), 'utf8')
  .replace(/^import \{([^}]*)\} from "gpui-kit";$/m, 'const {$1} = globalThis.__herdr.gpuiKit;')
  .replace(/^import \{([^}]*)\} from "gpui-base";$/m, 'const {$1} = globalThis.__herdr.gpuiBase;')
  .replace(/^import \{([^}]*)\} from "herdr";$/m, 'const {$1} = globalThis.__herdr.herdr;');
const file = join(mkdtempSync(join(tmpdir(), 'herdr-board-panel-')), 'main.mjs');
writeFileSync(file, src);
const Panel = (await import(pathToFileURL(file).href)).default;

const cx = { notify() {}, spawn: (f) => f(cx), timer: { after: () => ({ cancel() {} }), every() {} } };
const LOCAL = { machine: '', script: 'C:/me/herdr-board.mjs', board: 'C:/me/board' };
const REMOTE = { machine: 'dataprep', script: 'D:/hb/herdr-board.mjs', board: 'D:/hb/board' };
const saved = () => world.shared['herdr-board.settings']?.boards;
const settings = () => { const v = new Panel(); world.props = { dialog: 'settings' }; v.init({}, cx); return v; };
const type = (row, c) => { row.script.set_value(c.script); row.boardDir.set_value(c.board); };

describe('settings dialog: Boards', () => {
  beforeEach(() => { world.shared = {}; world.execs = []; world.machines = [{ name: 'dataprep' }]; world.lsJson = '{"board":"b","maxParallel":2}'; });

  test('adding a remote board next to the saved local one keeps both', () => {
    world.shared['herdr-board.settings'] = { boards: [LOCAL] };
    const v = settings();
    v.addRow(cx);
    assert.equal(v.rows[1].machine, 'dataprep');
    type(v.rows[1], REMOTE);
    v.saveRows(cx);
    assert.deepEqual(saved().map(({ machine, script, board }) => ({ machine, script, board })), [LOCAL, REMOTE]);
  });

  test('adding this computer next to the saved remote board keeps both', () => {
    world.shared['herdr-board.settings'] = { boards: [REMOTE] };
    const v = settings();
    v.addRow(cx);
    assert.equal(v.rows[1].machine, '');
    type(v.rows[1], LOCAL);
    v.saveRows(cx);
    assert.deepEqual(saved().map(({ machine, script, board }) => ({ machine, script, board })), [REMOTE, LOCAL]);
  });

  test('older single-connection settings become the first row, the added board the second', () => {
    world.shared['herdr-board.settings'] = { ...REMOTE };
    const v = settings();
    v.addRow(cx);
    type(v.rows[1], LOCAL);
    v.saveRows(cx);
    assert.equal(saved().length, 2);
    assert.equal(saved()[0].machine, 'dataprep');
    assert.equal(saved()[1].machine, '');
  });

  test('first run: the empty row is the board for this computer, the added one a machine', () => {
    const v = settings();
    type(v.rows[0], LOCAL);
    v.saveRows(cx);
    v.addRow(cx);
    type(v.rows[1], REMOTE);
    v.saveRows(cx);
    assert.equal(saved().length, 2);
    assert.deepEqual(world.shared['herdr-board.settings'].boards.map((b) => b.machine), ['', 'dataprep']);
  });

  test('each board is read on its own machine', async () => {
    world.shared['herdr-board.settings'] = { boards: [LOCAL, REMOTE] };
    settings();
    await Promise.resolve();
    assert.deepEqual(world.execs.map((e) => e.on).sort(), ['', 'dataprep'].map((m) => m || null).sort());
  });
});

describe('what the header says', () => {
  const read = async (conns, fail = {}, ls = {}) => {
    world.shared['herdr-board.settings'] = { boards: conns };
    world.exec = (o) => fail[o.on ?? ''] ?? { code: 0, stdout: JSON.stringify({ board: 'b', maxParallel: 2, running: 0, cards: [], repos: {}, ...(ls[o.on ?? ''] ?? {}) }), stderr: '' };
    const v = new Panel(); world.props = {}; v.init({}, cx);
    v.srcs = {};
    for (const c of [LOCAL, REMOTE].filter((c) => conns.includes(c))) v.refreshOne(cx, { machine: c.machine || null, script: c.script, board: c.board });
    await new Promise((r) => setTimeout(r, 5));
    world.exec = null;
    return v.errors();
  };

  test('a missing CLI names the machine and the path', async () => {
    const e = await read([REMOTE], { dataprep: { code: 1, stdout: '', stderr: "Error: Cannot find module 'D:/hb/herdr-board.mjs'" } });
    assert.deepEqual(e, ['No board CLI at D:/hb/herdr-board.mjs on dataprep. Check ⚙ → Boards.']);
  });

  test('a missing board.json names the machine and the folder; the local board says This computer', async () => {
    const miss = { code: 1, stdout: '', stderr: 'herdr-board: no board.json in C:/me/board (use --board <dir>)' };
    assert.match((await read([LOCAL], { '': miss }))[0], /No board\.json in C:\/me\/board on This computer/);
  });

  test('any other failure starts with the machine', async () => {
    const e = await read([REMOTE], { dataprep: { code: 255, stdout: '', stderr: 'ssh: connection refused' } });
    assert.deepEqual(e, ['dataprep: ssh: connection refused']);
  });

  test('a remote CLI that differs from the local one is flagged, an equal one is not', async () => {
    const e = await read([LOCAL, REMOTE], {}, { '': { cli: 'aaa' }, dataprep: { cli: 'bbb' } });
    assert.equal(e.length, 1);
    assert.match(e[0], /dataprep.*version bbb, not the same as this computer's\. Run \.\/deploy\.sh again\./);
    assert.deepEqual(await read([LOCAL, REMOTE], {}, { '': { cli: 'aaa' }, dataprep: { cli: 'aaa' } }), []);
  });

  test('a remote CLI too old to report a version is flagged; no local board, no flag', async () => {
    assert.equal((await read([LOCAL, REMOTE], {}, { '': { cli: 'aaa' }, dataprep: { cli: undefined } })).length, 1);
    assert.deepEqual(await read([REMOTE], {}, { dataprep: { cli: 'bbb' } }), []);
  });
});
