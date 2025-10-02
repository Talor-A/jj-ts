#!/usr/bin/env bun

import { $ } from "bun";
import { z } from "zod";
import { assert } from "./lib/assert";

const GH = process.env.GH_BIN ? process.env.GH_BIN.split(" ") : ["gh"];
const JJ = process.env.JJ_BIN ? process.env.JJ_BIN.split(" ") : ["jj"];

const prItemFullSchema = z.object({
  number: z.number(),
  title: z.string(),
  baseRefName: z.string(),
});
const prListFullSchema = z.array(prItemFullSchema);
const prItemLiteSchema = z.object({
  number: z.number(),
  title: z.string(),
});
const prListLiteSchema = z.array(prItemLiteSchema);

export async function jjPr(revset: string) {
  console.log("PR Stack:");
  console.log("---------");

  // Get all mutable commits in the revset (pass revset with '&' as one arg)
  const revArg = `${revset} & mutable()`;
  const commits = await $`${JJ} log --no-graph -r ${revArg} -T change_id`.text();
  const commitIds = commits.trim().split("\n").filter((id) => id.length > 0);

  // Store PR information
  interface PrInfo {
    head: string;
    base: string;
    number?: string;
    title?: string;
    currentBase?: string;
    status?: string;
  }

  const prInfo = new Map<string, PrInfo>();

  for (const commitId of commitIds) {
    // Get the head bookmark name
    let headBranch = (await $`${JJ} bookmark list -r ${commitId} -T name`.text()).trim();
    if (headBranch.includes("\n")) headBranch = headBranch.split("\n")[0]!;

    if (!headBranch) {
      // Create a bookmark for this commit if none exists
      headBranch = `push/gen-${Math.ceil(Math.random()*123456).toString(16)}`;
      await $`${JJ} bookmark set ${headBranch} -r ${commitId}`;
    }

    // Ensure the head branch exists on the remote (safe to repeat)
    try {
      await $`${JJ} git push --branch ${headBranch} --allow-new`;
    } catch {}

    // Get base branch by asking for the closest bookmark (parent)
    const closestArg = `closest_bookmark(${commitId}-)`;
    const baseBranches = await $`${JJ} bookmark list -r ${closestArg} -T name`.text();
    const baseBranch = baseBranches.trim().split("\n")[0] || "main";

    // Skip PRs where head equals base (e.g., main -> main)
    if (headBranch === baseBranch) {
      const info: PrInfo = { head: headBranch, base: baseBranch, status: "no change" };
      prInfo.set(commitId, info);
      continue;
    }

    const info: PrInfo = { head: headBranch, base: baseBranch };

    // Check if PR already exists
    const prListOutput = await $`${GH} pr list --head ${headBranch} --json number,title,baseRefName`.text();
    const prList = prListFullSchema.parse(JSON.parse(prListOutput || "[]"));

    if (prList.length > 0) {
      const prData = prList[0];
      assert(prData, "PR data should exist");

      info.number = prData.number.toString();
      info.title = prData.title;
      info.currentBase = prData.baseRefName;

      // Check if base branch needs updating
      if (info.currentBase !== baseBranch) {
        await $`${GH} pr edit ${info.number} --base ${baseBranch}`;
        info.status = "updated";
      } else {
        info.status = "no change";
      }
    } else {
      // Create new PR and retry once if head isn't a remote branch yet
      console.log(`Creating new PR for ${headBranch} -> ${baseBranch}`);
      let created = false;
      try {
        await $`${GH} pr create --head ${headBranch} --base ${baseBranch} --draft --fill`;
        created = true;
      } catch (e) {
        try {
          await $`${JJ} git push --branch ${headBranch} --allow-new`;
        } catch {}
        await $`${GH} pr create --head ${headBranch} --base ${baseBranch} --draft --fill`;
        created = true;
      }

      if (created) {
        // Get the PR number after creation
        const newPrListOutput = await $`${GH} pr list --head ${headBranch} --json number,title`.text();
        const newPrList = prListLiteSchema.parse(JSON.parse(newPrListOutput || "[]"));
        if (newPrList.length > 0) {
          assert(newPrList[0], "New PR data should exist");
          info.number = newPrList[0].number.toString();
          info.title = newPrList[0].title;
          info.status = "new";
        }
      }
    }

    prInfo.set(commitId, info);

    // Print the PR information
    const number = info.number || "ERROR";
    const title = info.title || "ERROR";
    const status = info.status || "ERROR";

    console.log(`# ${number} ${title} ${info.head} -> ${info.base} (${status})`);
  }
}

interface RevisionInfo {
  changeId: string;
  parents: string[];
  children: string[];
}

export async function getRevisionGraph(revset: string): Promise<RevisionInfo[]> {
  // Get all change IDs in the revset
  const changeIdsStr = await $`${JJ} log --no-graph -r ${revset} -T change_id`.text();
  const changeIds = changeIdsStr.trim().split("\n").filter(id => id.length > 0);

  const results: RevisionInfo[] = [];

  for (const changeId of changeIds) {
    // Get parents for this specific revision
    const parentsStr = await $`${JJ} log --no-graph -r ${changeId} -T 'parents.map(|c| c.change_id()).join("\\n")'`.text();
    const parents = parentsStr.trim().split("\n").filter(id => id.length > 0);

    // Get children for this specific revision
    const childrenStr = await $`${JJ} log --no-graph -r 'children(${changeId})' -T change_id`.text();
    const children = childrenStr.trim().split("\n").filter(id => id.length > 0);

    results.push({ changeId, parents, children });
  }

  return results;
}

if (require.main === module) {
  // Get revset from command line arguments (default to @)
  const revset = process.argv[2] || "@";
  await jjPr(revset);
}
