#!/usr/bin/env bun
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

// Minimal gh stub implementing: pr list|create|edit
// State format:
// { prs: [{ number, title, headRefName, baseRefName }], nextNumber: 1 }

type PR = { number: number; title: string; headRefName: string; baseRefName: string };
interface GHState { prs: PR[]; nextNumber: number }

const statePathEnv = process.env.GH_STUB_STATE ?? "";
if (!statePathEnv) {
  console.error("GH_STUB_STATE is required");
  process.exit(2);
}
const statePath: string = statePathEnv;

async function load(file: string): Promise<GHState> {
  if (!existsSync(file)) return { prs: [], nextNumber: 1 };
  const raw = await readFile(file, "utf8");
  return raw.trim() ? JSON.parse(raw) : { prs: [], nextNumber: 1 };
}
async function save(file: string, state: GHState) {
  await writeFile(file, JSON.stringify(state, null, 2));
}
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
function requireFlag(args: string[], name: string): string {
  const v = flag(args, name);
  if (!v) {
    console.error(`missing ${name}`);
    process.exit(2);
  }
  return v;
}

const args = process.argv.slice(2);
if (args[0] !== "pr") {
  console.error("only 'gh pr ...' supported in stub");
  process.exit(2);
}
const sub = args[1];
const state = await load(statePath);

if (sub === "list") {
  const head = requireFlag(args, "--head");
  const jsonFields = (flag(args, "--json") || "").split(",").filter(Boolean);
  const results = state.prs.filter((p) => p.headRefName === head);
  if (jsonFields.length) {
    const arr = results.map((p) => {
      const o: Record<string, unknown> = {};
      for (const f of jsonFields) {
        if (f === "number") o.number = p.number;
        else if (f === "title") o.title = p.title;
        else if (f === "baseRefName") o.baseRefName = p.baseRefName;
        else if (f === "headRefName") o.headRefName = p.headRefName;
      }
      return o;
    });
    process.stdout.write(JSON.stringify(arr));
  } else {
    process.stdout.write(results.map((p) => `#${p.number} ${p.title}`).join("\n"));
  }
  process.exit(0);
}

if (sub === "create") {
  const head = requireFlag(args, "--head");
  const base = requireFlag(args, "--base");
  const pr: PR = {
    number: state.nextNumber++,
    title: `Draft: ${head}`,
    headRefName: head,
    baseRefName: base,
  };
  state.prs.push(pr);
  await save(statePath, state);
  process.stdout.write(`created #${pr.number}\n`);
  process.exit(0);
}

if (sub === "edit") {
  const numberStr = args[2];
  const number = Number(numberStr);
  if (!Number.isFinite(number)) {
    console.error("invalid PR number");
    process.exit(2);
  }
  const base = requireFlag(args, "--base");
  const pr = state.prs.find((p) => p.number === number);
  if (!pr) {
    console.error("PR not found");
    process.exit(1);
  }
  pr.baseRefName = base;
  await save(statePath, state);
  process.stdout.write(`edited #${pr.number}\n`);
  process.exit(0);
}

console.error("unsupported gh pr subcommand");
process.exit(2);
