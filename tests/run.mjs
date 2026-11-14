#!/usr/bin/env node
// Runs the test suite with Node's built-in runner, no packages:  node tests/run.mjs
// (the same as `node --test tests/*.test.mjs`, but works in any shell and on Node 18+)
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here).filter(f => f.endsWith('.test.mjs')).sort().map(f => join(here, f));
const r = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
