import {
  describe,
  expect,
  test,
  afterAll,
  beforeAll,
  afterEach,
  beforeEach,
} from "bun:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { $ } from "bun";
import { jjPr, getRevisionGraph } from "..";
import type { JJState } from "./stubs/jj";
import type { GHState } from "./stubs/gh";
import { assert } from "../lib/assert";

async function tmpdir(prefix: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

const root = path.resolve(path.join(import.meta.dir!, ".."));
const stubsDir = path.join(root, "test", "stubs");
const ghStub = path.join(stubsDir, "gh.ts");
const jjStub = path.join(stubsDir, "jj.ts");

const testJjConfigPath = path.join(import.meta.dir, "test-config.toml");

let cleanupDirs: string[] = [];

beforeEach(() => {
  $.throws(true);
});

afterEach(() => {
  for (const dir of cleanupDirs) {
    try {
      $`rm -rf ${dir}`;
    } catch (e) {}
  }
  cleanupDirs = [];
});

async function runOnce(cwd: string, ghState: GHState, revset: string) {
  const dir = await tmpdir("jjts-");
  const ghPath = path.join(dir, "gh.json");

  await writeFile(ghPath, JSON.stringify(ghState));

  const env = {
    ...process.env,
    GH_STUB_STATE: ghPath,
    GH_BIN: `bun ${ghStub}`,
  };

  const p = Bun.spawn(["bun", "run", path.resolve(root, "index.ts"), revset], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  await p.exited;
  const stdout = await new Response(p.stdout).text();
  const stderr = await new Response(p.stderr).text();

//   console.log("STDOUT:", stdout);
//   console.log("STDERR:", stderr);
  return { stdout, stderr };
}

describe("config file override works", () => {
  test("jj respects the config file override", async () => {
    const repoDir = await tmpdir("jj-e2e-");
    // Initialize a jj repository with a custom config file
    await $`jj --config-file ${testJjConfigPath} git init --colocate ${repoDir}`;
    // Check that the user.name and user.email are set from the config file
    const name = (
      await $`jj -R ${repoDir} --config-file ${testJjConfigPath} config get user.name`.text()
    ).trim();
    const email = (
      await $`jj -R ${repoDir} --config-file ${testJjConfigPath} config get user.email`.text()
    ).trim();
    expect(name).toBe("Test User");
    expect(email).toBe("testuser@example.com");
  });

  test("within tested version range", async () => {
    const out = await $`jj --config-file ${testJjConfigPath} --version`.text();
    const [major, minor, patch] =
      out
        .trim()
        .match(/.*(\d+)\.(\d+)\.(\d+)/)
        ?.slice(1)
        .map(Number) || [];
    expect(major).toBe(0);
    expect(minor).toBeLessThanOrEqual(33);
    expect(minor).toBeGreaterThan(0);
    expect(patch).toBeNumber();
  });
});

describe("single PR", () => {
  test("creates a pull request for a single commit", async () => {
    const repoDir = await tmpdir("jj-e2e-");
    const originDir = await tmpdir("jj-e2e-origin-");

    // Initialize origin repository
    await $`git init --initial-branch=main ${originDir} --bare`;
    await $`git -C ${originDir} config user.name "Test User"`;
    await $`git -C ${originDir} config user.email "`;

    // Set up a jj repository
    await $`jj --config-file ${testJjConfigPath} git init --colocate ${repoDir}`;

    // add some content to our change
    await $`echo "Hello, World!" > ${path.join(repoDir, "hello.txt")}`;
    await $`jj -R ${repoDir} --config-file ${testJjConfigPath} desc -m "initial commit"`;
    expect(
      await $`jj -R ${repoDir} --config-file ${testJjConfigPath} status`.text()
    ).toMatch(/Working copy  \(@\) : [a-z]+ \w+ initial commit/);
    // get a clean change
    await $`jj -R ${repoDir} --config-file ${testJjConfigPath} new`;

    // Set up remote
    await $`jj -R ${repoDir} --config-file ${testJjConfigPath} git remote add origin ${originDir}`;

    // create a main bookmark pointing to @-
    await $`jj -R ${repoDir} --config-file ${testJjConfigPath} bookmark create main --revision @-`;

    await $`jj -R ${repoDir} --config-file ${testJjConfigPath} git push --branch main --allow-new`;

    // make a change
    await $`echo "Some changes" >> ${path.join(repoDir, "hello.txt")}`;
    await $`jj -R ${repoDir} --config-file ${testJjConfigPath} desc -m "made a change"`;
    await $`jj -R ${repoDir} --config-file ${testJjConfigPath} new`;

    const { stderr, stdout } = await runOnce(
      repoDir,
      { nextNumber: 1, prs: [] },
      "@-"
    );

    expect(stderr).toMatch(
      /^Created 1 bookmarks pointing to \w+ \w+ push\/gen\-\w+ \| made a change\nChanges to push to origin:\n  Add bookmark push\/gen\-\w+ to \w+\n$/
    );
    expect(stdout).toMatch(
      /^PR Stack:\n---------\nCreating new PR for push\/gen-\w+ -> main\ncreated #1\n# 1 Draft: push\/gen-\w+ push\/gen-\w+ \-\> main \(new\)\n$/
    );

    expect(
      await $`jj -R ${repoDir} --config-file ${testJjConfigPath} bookmark list`.text()
    ).toMatch(
      /^main: \w+ \w+ initial commit\npush\/gen-\w+: \w+ \w+ made a change\n$/
    );
  });
});

describe("getRevisionGraph", () => {
  test("gets a simple revision", async () => {
    const repoDir = await tmpdir("jj-graph-");

    // Initialize repository
    await $`jj --config-file ${testJjConfigPath} git init ${repoDir}`;

    // Create a simple commit
    await $`echo "file1" > ${path.join(repoDir, "file1.txt")}`;
    await $`jj -R ${repoDir} --config-file ${testJjConfigPath} desc -m "commit 1"`;

    // Set JJ_BIN env var for getRevisionGraph
    process.env.JJ_BIN = `jj -R ${repoDir} --config-file ${testJjConfigPath}`;

    const results = await getRevisionGraph("@");

    expect(results).toHaveLength(1);
    expect(results[0]?.changeId).toBeString();
    expect(results[0]?.parents).toHaveLength(1); // root commit
    expect(results[0]?.children).toHaveLength(0);

    delete process.env.JJ_BIN;
  });

  test("gets a revision with two children", async () => {
    const repoDir = await tmpdir("jj-graph-");

    // Initialize repository
    await $`jj --config-file ${testJjConfigPath} git init ${repoDir}`;

    // Create parent commit
    await $`echo "file1" > ${path.join(repoDir, "file1.txt")}`;
    await $`jj -R ${repoDir} --config-file ${testJjConfigPath} desc -m "parent"`;

    process.env.JJ_BIN = `jj -R ${repoDir} --config-file ${testJjConfigPath}`;
    const parentChangeId = (
      await $`jj -R ${repoDir} --config-file ${testJjConfigPath} log -r @ -T change_id --no-graph`.text()
    ).trim();

    // Create first child
    await $`jj -R ${repoDir} --config-file ${testJjConfigPath} new`;
    await $`echo "child1" > ${path.join(repoDir, "child1.txt")}`;
    await $`jj -R ${repoDir} --config-file ${testJjConfigPath} desc -m "child 1"`;

    // Create second child from parent
    await $`jj -R ${repoDir} --config-file ${testJjConfigPath} new ${parentChangeId}`;
    await $`echo "child2" > ${path.join(repoDir, "child2.txt")}`;
    await $`jj -R ${repoDir} --config-file ${testJjConfigPath} desc -m "child 2"`;

    const results = await getRevisionGraph(parentChangeId);

    expect(results).toHaveLength(1);
    expect(results[0]?.changeId).toBe(parentChangeId);
    expect(results[0]?.children).toHaveLength(2);

    delete process.env.JJ_BIN;
  });

  test("gets a revision with two parents (merge)", async () => {
    const repoDir = await tmpdir("jj-graph-");

    // Initialize repository
    await $`jj --config-file ${testJjConfigPath} git init ${repoDir}`;

    process.env.JJ_BIN = `jj -R ${repoDir} --config-file ${testJjConfigPath}`;

    // Create first parent
    await $`echo "file1" > ${path.join(repoDir, "file1.txt")}`;
    await $`jj -R ${repoDir} --config-file ${testJjConfigPath} desc -m "parent 1"`;
    const parent1ChangeId = (
      await $`jj -R ${repoDir} --config-file ${testJjConfigPath} log -r @ -T change_id --no-graph`.text()
    ).trim();

    // Create second parent - need to use array syntax for root()
    const jjCmd = [
      "jj",
      "-R",
      repoDir,
      "--config-file",
      testJjConfigPath,
      "new",
      "root()",
    ];
    await $`${jjCmd}`;
    await $`echo "file2" > ${path.join(repoDir, "file2.txt")}`;
    await $`jj -R ${repoDir} --config-file ${testJjConfigPath} desc -m "parent 2"`;
    const parent2ChangeId = (
      await $`jj -R ${repoDir} --config-file ${testJjConfigPath} log -r @ -T change_id --no-graph`.text()
    ).trim();

    // Create merge commit
    const mergeCmd = [
      "jj",
      "-R",
      repoDir,
      "--config-file",
      testJjConfigPath,
      "new",
      parent1ChangeId,
      parent2ChangeId,
    ];
    await $`${mergeCmd}`;
    await $`jj -R ${repoDir} --config-file ${testJjConfigPath} desc -m "merge"`;

    const results = await getRevisionGraph("@");

    assert(results[0], "Result should exist");
    expect(results[0].parents).toHaveLength(2);
    expect(results[0].parents).toContain(parent1ChangeId);
    expect(results[0].parents).toContain(parent2ChangeId);

    delete process.env.JJ_BIN;
  });

  test("gets a revision with two parents and two children", async () => {
    const repoDir = await tmpdir("jj-graph-");

    // Initialize repository
    await $`jj --config-file ${testJjConfigPath} git init ${repoDir}`;

    process.env.JJ_BIN = `jj -R ${repoDir} --config-file ${testJjConfigPath}`;

    // Create first parent
    await $`echo "file1" > ${path.join(repoDir, "file1.txt")}`;
    await $`jj -R ${repoDir} --config-file ${testJjConfigPath} desc -m "parent 1"`;
    const parent1ChangeId = (
      await $`jj -R ${repoDir} --config-file ${testJjConfigPath} log -r @ -T change_id --no-graph`.text()
    ).trim();

    // Create second parent
    const jjCmd = [
      "jj",
      "-R",
      repoDir,
      "--config-file",
      testJjConfigPath,
      "new",
      "root()",
    ];
    await $`${jjCmd}`;
    await $`echo "file2" > ${path.join(repoDir, "file2.txt")}`;
    await $`jj -R ${repoDir} --config-file ${testJjConfigPath} desc -m "parent 2"`;
    const parent2ChangeId = (
      await $`jj -R ${repoDir} --config-file ${testJjConfigPath} log -r @ -T change_id --no-graph`.text()
    ).trim();

    // Create merge commit
    const mergeCmd = [
      "jj",
      "-R",
      repoDir,
      "--config-file",
      testJjConfigPath,
      "new",
      parent1ChangeId,
      parent2ChangeId,
    ];
    await $`${mergeCmd}`;
    await $`jj -R ${repoDir} --config-file ${testJjConfigPath} desc -m "merge"`;
    const mergeChangeId = (
      await $`jj -R ${repoDir} --config-file ${testJjConfigPath} log -r @ -T change_id --no-graph`.text()
    ).trim();

    // Create first child
    await $`jj -R ${repoDir} --config-file ${testJjConfigPath} new`;
    await $`echo "child1" > ${path.join(repoDir, "child1.txt")}`;
    await $`jj -R ${repoDir} --config-file ${testJjConfigPath} desc -m "child 1"`;

    // Create second child from merge
    await $`jj -R ${repoDir} --config-file ${testJjConfigPath} new ${mergeChangeId}`;
    await $`echo "child2" > ${path.join(repoDir, "child2.txt")}`;
    await $`jj -R ${repoDir} --config-file ${testJjConfigPath} desc -m "child 2"`;

    const results = await getRevisionGraph(mergeChangeId);

    expect(results).toHaveLength(1);
    expect(results[0]?.parents).toHaveLength(2);
    expect(results[0]?.children).toHaveLength(2);

    delete process.env.JJ_BIN;
  });

  test("gets multiple revisions", async () => {
    const repoDir = await tmpdir("jj-graph-");

    // Initialize repository
    await $`jj --config-file ${testJjConfigPath} git init ${repoDir}`;

    process.env.JJ_BIN = `jj -R ${repoDir} --config-file ${testJjConfigPath}`;

    // Create first commit
    await $`echo "file1" > ${path.join(repoDir, "file1.txt")}`;
    await $`jj -R ${repoDir} --config-file ${testJjConfigPath} desc -m "commit 1"`;

    // Create second commit
    await $`jj -R ${repoDir} --config-file ${testJjConfigPath} new`;
    await $`echo "file2" > ${path.join(repoDir, "file2.txt")}`;
    await $`jj -R ${repoDir} --config-file ${testJjConfigPath} desc -m "commit 2"`;

    // Create third commit
    await $`jj -R ${repoDir} --config-file ${testJjConfigPath} new`;
    await $`echo "file3" > ${path.join(repoDir, "file3.txt")}`;
    await $`jj -R ${repoDir} --config-file ${testJjConfigPath} desc -m "commit 3"`;

    const results = await getRevisionGraph("@--::@");

    expect(results).toHaveLength(3);
    expect(results[0]?.changeId).toBeString();
    expect(results[1]?.changeId).toBeString();
    expect(results[2]?.changeId).toBeString();

    delete process.env.JJ_BIN;
  });
});
