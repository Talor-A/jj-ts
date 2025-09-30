#!/usr/bin/env bun
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

// Minimal jj stub implementing: log, bookmark list/set, git push
// State format:
// {
//   revsets: { "@": ["11111111", "22222222"] },
//   bookmarks: { "11111111": "feature/11111111" },
//   bases: { "11111111": "main" }
// }

type JJState = {
  revsets: Record<string, string[]>;
  bookmarks: Record<string, string>;
  bases: Record<string, string>;
};

const statePathEnv = process.env.JJ_STUB_STATE ?? "";
if (!statePathEnv) {
  console.error("JJ_STUB_STATE is required");
  process.exit(2);
}
const statePath: string = statePathEnv;

async function load(file: string): Promise<JJState> {
  if (!existsSync(file)) return { revsets: { "@": [] }, bookmarks: {}, bases: {} };
  const raw = await readFile(file, "utf8");
  return raw.trim() ? JSON.parse(raw) : { revsets: { "@": [] }, bookmarks: {}, bases: {} };
}
async function save(file: string, state: JJState) {
  await writeFile(file, JSON.stringify(state, null, 2));
}
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
function closestBookmarkSpecToId(spec: string): string | null {
  const m = spec.match(/^closest_bookmark\((.+)-\)$/);
  return m ? m[1] : null;
}

const args = process.argv.slice(2);
const state = await load(statePath);

if (args[0] === "git" && args[1] === "push") {
  // no-op
  process.exit(0);
}

if (args[0] === "log") {
  let revset = flag(args, "-r") || "@";
  // Support patterns like "@ & mutable()" and trim spaces
  const m = revset.match(/^(.*)\s*&\s*mutable\(\)\s*$/);
  if (m) revset = m[1];
  revset = revset.trim();
  const ids = state.revsets[revset] || [];
  process.stdout.write(ids.join("\n") + (ids.length ? "\n" : ""));
  process.exit(0);
}

if (args[0] === "bookmark" && args[1] === "list") {
  const spec = flag(args, "-r") || "";
  const id = closestBookmarkSpecToId(spec);
  if (id !== null) {
    const base = state.bases[id] ?? "main";
    process.stdout.write(base ? base + "\n" : "");
    process.exit(0);
  } else {
    const name = state.bookmarks[spec] || "";
    process.stdout.write(name ? name + "\n" : "");
    process.exit(0);
  }
}

if (args[0] === "bookmark" && args[1] === "set") {
  const name = args[2];
  const commitId = flag(args, "-r");
  if (!name || !commitId) {
    console.error("usage: jj bookmark set <name> -r <commitId>");
    process.exit(2);
  }
  state.bookmarks[commitId] = name;
  await save(statePath, state);
  process.exit(0);
}

console.error("unsupported jj subcommand in stub");
process.exit(2);
