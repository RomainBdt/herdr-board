#!/usr/bin/env node
// Validates a change in two places and prints PASS or FAIL for each:
//   local   the check command, run here
//   remote  the same command, run over ssh on the fake SSH machine (a second sshd on this PC)
//
//   node check.mjs [--dir <repo folder>] [--cmd "<command>"] [--skip-local] [--skip-remote]
//
// --dir     the folder to check (default: the current folder). The fake machine is this same PC, so the
//           same path is used on both sides.
// --cmd     the command to run there (default: `node tests/run.mjs`, else `npm test`).
// Exit code: 0 both sides passed, 1 a side failed, 2 the check itself could not run.
//
// The fake machine lives in ~/fake-server (or $HERDR_FAKE_SERVER): sshd_config, id_fake, hostkey, authorized_keys.
// This script never touches ~/.ssh/config or the `fakeserver` alias, so the running Herdr app never sees it. It starts
// its own sshd on a free local port, hidden (no window), and stops it, with every session it opened, when done.
// The sshd it starts is its own: one that is already running is neither used nor stopped.
//
// Test hook: HERDR_CHECK_SSH='["prog","arg"]' replaces the ssh program (and skips starting an sshd): it is run as
// `prog arg <remote command>`. Only tests/check.test.mjs uses it.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const WIN = process.platform === 'win32';
const slash = p => p.replace(/\\/g, '/');
const TIMEOUT_MS = 5 * 60 * 1000;

function parseArgs(argv) {
  const o = { dir: process.cwd(), cmd: null, skipLocal: false, skipRemote: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') o.dir = argv[++i];
    else if (a === '--cmd') o.cmd = argv[++i];
    else if (a === '--skip-local') o.skipLocal = true;
    else if (a === '--skip-remote') o.skipRemote = true;
    else if (a === '-h' || a === '--help') { console.log('node check.mjs [--dir <folder>] [--cmd "<command>"] [--skip-local] [--skip-remote]'); process.exit(0); }
    else usage(`unknown option: ${a}`);
  }
  if (!o.dir) usage('--dir needs a folder');
  if (o.cmd === undefined) usage('--cmd needs a command');
  o.dir = slash(resolve(o.dir));
  return o;
}
function usage(msg) { console.error(`check: ${msg}`); process.exit(2); }

function defaultCommand(dir) {
  if (existsSync(join(dir, 'tests', 'run.mjs'))) return 'node tests/run.mjs';
  if (existsSync(join(dir, 'package.json')) && /"test"\s*:/.test(readFileSync(join(dir, 'package.json'), 'utf8'))) return 'npm test';
  return null;
}

const tail = (s, n = 25) => s.trim().split(/\r?\n/).slice(-n).join('\n');

// Runs a program; returns { ok, ms, output }. Never opens a window.
function run(file, args, opts = {}) {
  const t0 = Date.now();
  const r = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: TIMEOUT_MS, ...opts });
  const output = `${r.stdout || ''}${r.stderr || ''}${r.error ? `\n${r.error.message}` : ''}`;
  return { ok: r.status === 0 && !r.error, ms: Date.now() - t0, output };
}

function localCheck(dir, cmd) {
  return run(cmd, [], { cwd: dir, shell: true });
}

// ---- the fake machine ----------------------------------------------------------------------------------------------

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}
function portOpen(port) {
  return new Promise(res => {
    const c = connect({ port, host: '127.0.0.1' });
    c.once('connect', () => { c.destroy(); res(true); });
    c.once('error', () => res(false));
  });
}

// Starts a private sshd on a free port. Returns { port, keyFile, known, stop }; throws with a reason if it cannot.
async function startFakeSshd() {
  const fake = slash(process.env.HERDR_FAKE_SERVER || join(homedir(), 'fake-server'));
  const cfg = `${fake}/sshd_config`, key = `${fake}/id_fake`;
  for (const f of [cfg, key]) if (!existsSync(f)) throw new Error(`fake SSH machine not set up: ${f} is missing`);
  const sshd = WIN ? slash(join(process.env.SystemRoot || 'C:/Windows', 'System32/OpenSSH/sshd.exe')) : 'sshd';
  const work = slash(mkdtempSync(join(tmpdir(), 'herdr-check-sshd-')));
  const port = await freePort();
  const log = `${work}/sshd.log`;
  // -D: stay in the foreground (so we can stop it); -o overrides the config: own port, own pid file.
  const child = spawn(sshd, ['-f', cfg, '-E', log, '-D', '-o', `Port=${port}`, '-o', `PidFile=${work}/sshd.pid`],
    { stdio: 'ignore', windowsHide: true });
  let died = null;
  child.once('exit', c => { died = c; });
  child.once('error', e => { died = e.message; });
  const stop = () => {
    if (child.pid && died === null) {
      if (WIN) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else child.kill('SIGKILL');
    }
    try { rmSync(work, { recursive: true, force: true }); } catch { /* the log may still be held for a moment */ }
  };
  for (let i = 0; i < 50 && died === null && !(await portOpen(port)); i++) await new Promise(r => setTimeout(r, 200));
  if (died !== null || !(await portOpen(port))) {
    const why = existsSync(log) ? tail(readFileSync(log, 'utf8'), 5) : String(died);
    stop();
    throw new Error(`could not start the fake sshd: ${why}`);
  }
  return { port, key, known: `${work}/known_hosts`, stop };
}

// The command to run in `dir` on the other side. The fake machine is Windows (cmd.exe is its ssh shell).
function remoteCommand(dir, cmd) {
  return WIN ? `cd /d "${dir.replace(/\//g, '\\')}" && ${cmd}` : `cd "${dir}" && ${cmd}`;
}

async function remoteCheck(dir, cmd) {
  const remote = remoteCommand(dir, cmd);
  if (process.env.HERDR_CHECK_SSH) {
    const [prog, ...pre] = JSON.parse(process.env.HERDR_CHECK_SSH);
    return run(prog, [...pre, remote]);
  }
  let box;
  try { box = await startFakeSshd(); }
  catch (e) { return { ok: false, ms: 0, output: e.message }; }
  const stopOnSignal = () => { box.stop(); process.exit(130); };
  process.once('SIGINT', stopOnSignal); process.once('SIGTERM', stopOnSignal);
  try {
    const sshExe = WIN ? slash(join(process.env.SystemRoot || 'C:/Windows', 'System32/OpenSSH/ssh.exe')) : 'ssh';
    // -F none: no ~/.ssh/config, so no alias and nothing for Herdr to pick up. -T: no terminal.
    const args = ['-F', 'none', '-T', '-o', 'BatchMode=yes', '-o', 'LogLevel=ERROR', '-o', 'ConnectTimeout=10', '-o', 'IdentitiesOnly=yes',
      '-o', 'StrictHostKeyChecking=no', '-o', `UserKnownHostsFile=${box.known}`,
      '-p', String(box.port), '-i', box.key, `${process.env.USERNAME || process.env.USER}@127.0.0.1`, remote];
    return run(sshExe, args);
  } finally {
    box.stop();
    process.removeListener('SIGINT', stopOnSignal); process.removeListener('SIGTERM', stopOnSignal);
  }
}

// ---- main ----------------------------------------------------------------------------------------------------------

const o = parseArgs(process.argv.slice(2));
const cmd = o.cmd ?? defaultCommand(o.dir);
if (!cmd) usage(`no tests/run.mjs or npm test script in ${o.dir}: pass --cmd "<command>"`);
if (o.skipLocal && o.skipRemote) usage('both sides skipped: nothing to check');

console.log(`check: ${cmd}   (in ${o.dir})`);
const results = [];
for (const [side, skip, fn] of [['local', o.skipLocal, () => localCheck(o.dir, cmd)], ['remote', o.skipRemote, () => remoteCheck(o.dir, cmd)]]) {
  if (skip) { console.log(`${side.padEnd(7)} SKIPPED`); continue; }
  const r = await fn();
  console.log(`${side.padEnd(7)} ${r.ok ? 'PASS' : 'FAIL'}  (${(r.ms / 1000).toFixed(1)}s)`);
  if (!r.ok) console.log(tail(r.output).replace(/^/gm, '        '));
  results.push(r.ok);
}
const ok = results.every(Boolean);
console.log(ok ? 'check: PASS' : 'check: FAIL');
process.exit(ok ? 0 : 1);
