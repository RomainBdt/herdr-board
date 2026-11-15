#!/usr/bin/env node
// Installs the board layout without losing the panels the person added to it.
//   node layout/merge-layout.mjs <repo layout> <installed layout>
// Writes the repo layout to <installed layout>, plus every block of the installed "panel-body" stack whose id
// the repo layout does not have (in their order, after the repo's own). Prints what it kept.
// No installed file, or one that is not valid JSON: the repo layout is written as it is (with a warning for the latter).
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const PANEL_STACK = 'panel-body';

export function findNode(node, id) {
  if (!node || typeof node !== 'object') return null;
  if (node.id === id) return node;
  for (const child of Array.isArray(node.children) ? node.children : []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

function ids(node, out = new Set()) {
  if (!node || typeof node !== 'object') return out;
  if (typeof node.id === 'string') out.add(node.id);
  for (const child of Array.isArray(node.children) ? node.children : []) ids(child, out);
  return out;
}

// Returns { layout, kept }: the repo layout with the installed layout's extra panel-body blocks appended,
// and the ids of those blocks. Neither input is changed.
export function mergeLayout(repo, installed) {
  const layout = structuredClone(repo);
  const body = findNode(layout, PANEL_STACK);
  const theirs = findNode(installed, PANEL_STACK);
  const kept = [];
  if (!body || !Array.isArray(body.children) || !theirs || !Array.isArray(theirs.children)) return { layout, kept };
  const taken = ids(layout);
  for (const child of theirs.children) {
    // A block needs its own id: an id the repo layout already uses anywhere is the repo's.
    if (!child || typeof child !== 'object' || typeof child.id !== 'string' || taken.has(child.id)) continue;
    taken.add(child.id);
    for (const id of ids(child)) taken.add(id);
    body.children.push(structuredClone(child));
    kept.push(child.id);
  }
  return { layout, kept };
}

export function installLayout(repoPath, installedPath) {
  const repo = JSON.parse(readFileSync(repoPath, 'utf8'));
  let installed = null, warning = null;
  if (existsSync(installedPath)) {
    try { installed = JSON.parse(readFileSync(installedPath, 'utf8')); }
    catch (e) { warning = `${installedPath} is not valid JSON (${e.message}); replaced by the repo layout, its extra panels are not kept.`; }
  }
  const { layout, kept } = installed ? mergeLayout(repo, installed) : { layout: repo, kept: [] };
  const tmp = `${installedPath}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(layout, null, 2) + '\n');
  renameSync(tmp, installedPath);
  return { kept, warning };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [repoPath, installedPath] = process.argv.slice(2);
  if (!repoPath || !installedPath) {
    console.error('usage: node layout/merge-layout.mjs <repo layout> <installed layout>');
    process.exit(2);
  }
  const { kept, warning } = installLayout(repoPath, installedPath);
  if (warning) console.error(`warning: ${warning}`);
  if (kept.length) console.log(`kept your panels in the layout: ${kept.join(', ')}`);
}
