// Shared by the tests: a throwaway board folder, and the CLI run on it. Never touches a real board.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CLI = join(ROOT, 'herdr-board.mjs');

// A PATH folder that does not exist: `hc` and `claude` cannot be found, even where they sit next to node
// (Homebrew, nvm + a global npm install). Node itself is always started from its full path.
export const NO_PATH = join(tmpdir(), 'herdr-board-test-no-path');

// An environment where `hc` and `claude` cannot be found, so a test never talks to a real Herdr session or starts
// an agent. HERDR_BOARD is dropped so only --board picks the board; HC_SESSION so no session is named.
export function isolatedEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(path|herdr_board|herdr_board_no_main|hc_session)$/i.test(k)) delete env[k];
  env.PATH = NO_PATH;
  return env;
}

// A new board in the system temp folder; repo "app" makes TST-<n> cards. Call cleanup() when done.
export function tempBoard() {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-board-test-'));
  mkdirSync(join(dir, 'cards'));
  const board = {
    name: 'test', maxParallel: 2, worktrees: join(dir, 'worktrees'),
    repos: { app: { path: join(dir, 'no-repo'), prefix: 'TST' }, other: { path: join(dir, 'no-repo-2'), prefix: 'OTH' } },
  };
  writeFileSync(join(dir, 'board.json'), JSON.stringify(board, null, 2));
  return {
    dir,
    card: (id) => join(dir, 'cards', `${id}.md`),
    read: (id) => readFileSync(join(dir, 'cards', `${id}.md`), 'utf8'),
    write: (id, text) => writeFileSync(join(dir, 'cards', `${id}.md`), text),
    run: (...args) => {
      const r = spawnSync(process.execPath, [CLI, '--board', dir, ...args], { env: isolatedEnv(), encoding: 'utf8' });
      return { code: r.status, out: r.stdout, err: r.stderr };
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// A card file as the CLI writes it.
export function cardText(meta, body = '## Where we are\n\n_The agent keeps this up to date._\n\n## Questions\n\n## Answers\n') {
  return `---\n${Object.entries(meta).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n\n${body}`;
}
