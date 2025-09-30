#!/usr/bin/env bun

import { $ } from "bun";
import { z } from "zod";
import { assert } from "./lib/assert";

const GH = process.env.GH_BIN ? process.env.GH_BIN.split(" ") : ["gh"];
const JJ = process.env.JJ_BIN ? process.env.JJ_BIN.split(" ") : ["jj"];

async function jjPr(revset: string) {
  // Push all changes in the revset
  await $`${JJ} git push -c all:${revset}`;

  console.log("PR Stack:");
  console.log("---------");

  // Get all mutable commits in the revset (pass revset with '&' as one arg)
  const revArg = `${revset} & mutable()`;
  const commits = await $`${JJ} log --no-graph -r ${revArg} -T change_id`.text();
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

  const prInfo = new Map<string, PrInfo>();

  for (const commitId of commitIds) {
    // Get the head bookmark name
    let headBranch = await $`${JJ} bookmark list -r ${commitId} -T name`.text();
    headBranch = headBranch.trim();

    if (!headBranch) {
      // Create a bookmark for this commit if none exists
      headBranch = `feature/${commitId.substring(0, 8)}`;
      await $`${JJ} bookmark set ${headBranch} -r ${commitId}`;
      // Need to push the new bookmark
      await $`${JJ} git push -c ${commitId}`;
    }

    // Get base branch
    // Ask for the closest bookmark (parent) for this commit
    const closestArg = `closest_bookmark(${commitId}-)`;
    const baseBranches = await $`${JJ} bookmark list -r ${closestArg} -T name`.text();
    let baseBranch = baseBranches.trim().split("\n")[0] || "main";

    // Initialize PR info for this commit
    const info: PrInfo = {
      head: headBranch,
      base: baseBranch,
    };

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
      // Create new PR
      console.log(`Creating new PR for ${headBranch} -> ${baseBranch}`);
      await $`${GH} pr create --head ${headBranch} --base ${baseBranch} --draft --fill`;

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
