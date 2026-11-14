// check.mjs: PASS/FAIL per side, and a failure on the remote side is a failure. The ssh program is replaced by a
// stub (HERDR_CHECK_SSH), so these tests never start an sshd or connect anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './helpers.mjs';

const CHECK = join(ROOT, 'check.mjs');
const dir = mkdtempSync(join(tmpdir(), 'herdr-board-check-'));
const stub = (code, text) => {
  const f = join(dir, `stub-${code}.mjs`);
  writeFileSync(f, `console.log(${JSON.stringify(text)}); process.exit(${code});`);
  return JSON.stringify([process.execPath, f]);
};
const check = (args, ssh) => {
  const env = { ...process.env }; delete env.HERDR_CHECK_SSH;
  if (ssh) env.HERDR_CHECK_SSH = ssh;
  const r = spawnSync(process.execPath, [CHECK, '--dir', dir, ...args], { env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
};
const OK = '--cmd "node -e 0"', BAD = '--cmd "node -e process.exit(3)"';
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

function run(args, ssh) { return check(args.flatMap(a => a.startsWith('--cmd') ? ['--cmd', a.slice(6).replace(/^"|"$/g, '')] : [a]), ssh); }

test('both sides pass: PASS twice, exit 0', () => {
  const r = run([OK], stub(0, 'remote ran'));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /local\s+PASS/);
  assert.match(r.out, /remote\s+PASS/);
});

test('a failure on the remote side is reported as FAIL, exit 1 (local still passes)', () => {
  const r = run([OK], stub(1, 'remote exploded'));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /local\s+PASS/);
  assert.match(r.out, /remote\s+FAIL/);
  assert.match(r.out, /remote exploded/);
  assert.match(r.out, /check: FAIL/);
});

test('a failure on the local side is reported as FAIL, exit 1 (remote still reported)', () => {
  const r = run([BAD], stub(0, 'ok'));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /local\s+FAIL/);
  assert.match(r.out, /remote\s+PASS/);
});

test('an ssh program that cannot start is a remote FAIL, not a crash', () => {
  const r = run([OK], JSON.stringify([join(dir, 'no-such-ssh')]));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /remote\s+FAIL/);
});

test('--skip-local / --skip-remote check one side only; both skipped is an error', () => {
  const a = run([OK, '--skip-local'], stub(1, 'x'));
  assert.equal(a.code, 1); assert.match(a.out, /local\s+SKIPPED/); assert.match(a.out, /remote\s+FAIL/);
  const b = run([OK, '--skip-remote']);
  assert.equal(b.code, 0, b.out); assert.match(b.out, /local\s+PASS/); assert.match(b.out, /remote\s+SKIPPED/);
  assert.equal(run([OK, '--skip-local', '--skip-remote']).code, 2);
});

test('no --cmd and nothing to detect: exit 2 with a hint', () => {
  const r = run(['--skip-remote']);
  assert.equal(r.code, 2);
  assert.match(r.out, /--cmd/);
});
