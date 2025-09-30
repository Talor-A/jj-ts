#!/usr/bin/env bun

import { $ } from "bun";
import { z } from "zod";
import { assert } from "./lib/assert";

async function jjPr(revset: string) {
  // Push all changes in the revset
  await $`jj git push -c all:${revset}`;

  console.log("PR Stack:");
  console.log("---------");

  // Get all mutable commits in the revset
  const commits = await $`jj log --no-graph -r ${revset} & mutable() -T change_id ++ '\n'`.text();
  const commitIds = commits
    .trim()
    .split("\n")
    .filter((id) => id.length > 0);

  // Store PR information
  interface PrInfo {
    head: string;
    base: string;
    number?: string;
    title?: string;
    currentBase?: string;
    status?: string;
  }

  // Zod schemas for parsing GitHub CLI JSON output
  const prItemSchema = z.object({
    number: z.number(),
    title: z.string(),
    baseRefName: z.string(),
  });

  const prListSchema = z.array(prItemSchema);

  const prInfo = new Map<string, PrInfo>();

  for (const commitId of commitIds) {
    // Get the head bookmark name
    let headBranch = await $`jj bookmark list -r ${commitId} -T name`.text();
    headBranch = headBranch.trim();

    if (!headBranch) {
      // Create a bookmark for this commit if none exists
      headBranch = `feature/${commitId.substring(0, 8)}`;
      await $`jj bookmark set ${headBranch} -r ${commitId}`;
      // Need to push the new bookmark
      await $`jj git push -c ${commitId}`;
    }

    // Get base branch
    const baseBranches =
      await $`jj bookmark list -r closest_bookmark(${commitId}-) -T name ++ '\n'`.text();
    let baseBranch = baseBranches.trim().split("\n")[0] || "main";

    // Initialize PR info for this commit
    const info: PrInfo = {
      head: headBranch,
      base: baseBranch,
    };

    // Check if PR already exists
    const prListOutput = await $`gh pr list --head ${headBranch} --json number,title,baseRefName`.text();
    const prList = prListSchema.parse(JSON.parse(prListOutput || "[]"));

    if (prList.length > 0) {
      const prData = prList[0];
      assert(prData, "PR data should exist");

      info.number = prData.number.toString();
      info.title = prData.title;
      info.currentBase = prData.baseRefName;

      // Check if base branch needs updating
      if (info.currentBase !== baseBranch) {
        await $`gh pr edit ${info.number} --base ${baseBranch}`;
        info.status = "updated";
      } else {
        info.status = "no change";
      }
    } else {
      // Create new PR
      console.log(`Creating new PR for ${headBranch} -> ${baseBranch}`);
      await $`gh pr create --head ${headBranch} --base ${baseBranch} --draft --fill`;

      // Get the PR number after creation
      const newPrListOutput = await $`gh pr list --head ${headBranch} --json number,title`.text();
      const newPrList = prListSchema.parse(JSON.parse(newPrListOutput || "[]"));

      if (newPrList.length > 0) {
        assert(newPrList[0], "New PR data should exist");
        
        info.number = newPrList[0].number.toString();
        info.title = newPrList[0].title;
        info.status = "new";
      }
    }

    prInfo.set(commitId, info);

    // Print the PR information
    const number = info.number || "ERROR";
    const title = info.title || "ERROR";
    const status = info.status || "ERROR";

    console.log(
      `# ${number} ${title} ${info.head} -> ${info.base} (${status})`
    );
  }
}

// Get revset from command line arguments (default to @)
const revset = process.argv[2] || "@";
await jjPr(revset);