import {describe, expect, test, afterAll, beforeAll,afterEach,beforeEach} from 'bun:test'
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { $ } from "bun";
import { jjPr } from '..';
import type { JJState } from './stubs/jj';
import type { GHState } from './stubs/gh';

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
    $.throws(true)
})

afterEach(() => {
    for (const dir of cleanupDirs) {
        try {
            $`rm -rf ${dir}`;
        } catch (e) {

        }
    }
    cleanupDirs = [];
})

async function runOnce(ghState: GHState, revset:string) {
  const dir = await tmpdir("jjts-");
  const ghPath = path.join(dir, "gh.json");

  await writeFile(ghPath, JSON.stringify(ghState));

  const env = {
    ...process.env,
    GH_STUB_STATE: ghPath,
    GH_BIN: `bun ${ghStub}`,
  };

  const p = Bun.spawn(["bun", "run", "index.ts", revset], {
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
    
describe("config file override works", () => {
    test('jj respects the config file override', async () => {
        const repoDir = await tmpdir("jj-e2e-");
        // Initialize a jj repository with a custom config file
        await $`jj --config-file ${testJjConfigPath} git init --colocate ${repoDir}`;
        // Check that the user.name and user.email are set from the config file
        const name = (await $`jj -R ${repoDir} --config-file ${testJjConfigPath} config get user.name`.text()).trim();
        const email = (await $`jj -R ${repoDir} --config-file ${testJjConfigPath} config get user.email`.text()).trim();
        expect(name).toBe("Test User");
        expect(email).toBe("testuser@example.com");
    })

    test('within tested version range', async () => {
        const out = await $`jj --config-file ${testJjConfigPath} --version`.text();
        const [major, minor, patch] = out.trim().match(/.*(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number) || [];
        expect(major).toBe(0);
        expect(minor).toBeLessThanOrEqual(33);
        expect(minor).toBeGreaterThan(0)
        expect(patch).toBeNumber()
    })
})




describe("single PR", () => {

    test('creates a pull request for a single commit', async () => {
        const repoDir = await tmpdir("jj-e2e-");
        const originDir = await tmpdir("jj-e2e-origin-");

        // Initialize origin repository
        await $`git init --initial-branch=main ${originDir} --bare`;
        await $`git -C ${originDir} config user.name "Test User"`;
        await $`git -C ${originDir} config user.email "`

        // Set up a jj repository
        await $`jj --config-file ${testJjConfigPath} git init --colocate ${repoDir}`;

        // add some content to our change
        await $`echo "Hello, World!" > ${path.join(repoDir, "hello.txt")}`;
        await $`jj -R ${repoDir} --config-file ${testJjConfigPath} desc -m "initial commit"`
        expect(await $`jj -R ${repoDir} --config-file ${testJjConfigPath} status`.text()).toMatch(
            /Working copy  \(@\) : [a-z]+ \w+ initial commit/
        )
        // get a clean change
        await $`jj -R ${repoDir} --config-file ${testJjConfigPath} new`

        // Set up remote
        await $`jj -R ${repoDir} --config-file ${testJjConfigPath} git remote add origin ${originDir}`;

        // create a main bookmark pointing to @-
        await $`jj -R ${repoDir} --config-file ${testJjConfigPath} bookmark create main --revision @-`;

        await $`jj -R ${repoDir} --config-file ${testJjConfigPath} git push --branch main --allow-new`;

        // make a change
        await $`echo "Some changes" >> ${path.join(repoDir, "hello.txt")}`;
        await $`jj -R ${repoDir} --config-file ${testJjConfigPath} desc -m "made a change"`;
        await $`jj -R ${repoDir} --config-file ${testJjConfigPath} new`;

       const {stderr, stdout}= await runOnce({ nextNumber:1, prs:[]}, "@-");

         expect(stderr).toBe("");   
         expect(stdout).toMatchInlineSnapshot(`
           "PR Stack:
           ---------
           "
         `)

         expect(await $`jj -R ${repoDir} --config-file ${testJjConfigPath} bookmark list`.text()).toMatchInlineSnapshot(`
           "main: wvrurqpr c832d2d7 initial commit
           "
         `)
    })


})