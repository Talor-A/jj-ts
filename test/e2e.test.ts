import { test, expect } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(path.join(import.meta.dir!, ".."));
const stubsDir = path.join(root, "test", "stubs");
const ghStub = path.join(stubsDir, "gh.ts");
const jjStub = path.join(stubsDir, "jj.ts");

async function tmpdir(prefix: string) {
  return await mkdtemp(path.join(os.tmpdir(), prefix));
}

async function runOnce(jjState: unknown, ghState: unknown) {
  const dir = await tmpdir("jjts-");
  const jjPath = path.join(dir, "jj.json");
  const ghPath = path.join(dir, "gh.json");
  await writeFile(jjPath, JSON.stringify(jjState));
  await writeFile(ghPath, JSON.stringify(ghState));

  const env = {
    ...process.env,
    JJ_STUB_STATE: jjPath,
    GH_STUB_STATE: ghPath,
    JJ_BIN: `bun ${jjStub}`,
    GH_BIN: `bun ${ghStub}`,
  };

  const p = Bun.spawn(["bun", "run", "index.ts", "@"], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  await p.exited;
  const stdout = await new Response(p.stdout).text();
  const stderr = await new Response(p.stderr).text();
  return { stdout, stderr };
}

test("creates a new PR for a commit without head bookmark", async () => {
  const jjState = {
    revsets: { "@": ["11111111"] },
    bookmarks: {},
    bases: { "11111111": "main" },
  };
  const ghState = { prs: [], nextNumber: 1 };
  const { stdout, stderr } = await runOnce(jjState, ghState);
  expect(stderr).toBe("");
  expect(stdout).toContain("PR Stack:");
  expect(stdout).toContain("Creating new PR for feature/11111111 -> main");
  expect(stdout).toContain("# 1 Draft: feature/11111111 feature/11111111 -> main (new)");
});

test("updates base when PR exists with different base", async () => {
  const jjState = {
    revsets: { "@": ["22222222"] },
    bookmarks: { "22222222": "feature/22222222" },
    bases: { "22222222": "feature/11111111" },
  };
  const ghState = {
    prs: [{ number: 1, title: "Existing", headRefName: "feature/22222222", baseRefName: "main" }],
    nextNumber: 2,
  };
  const { stdout, stderr } = await runOnce(jjState, ghState);
  expect(stderr).toBe("");
  expect(stdout).toContain("# 1 Existing feature/22222222 -> feature/11111111 (updated)");
});
