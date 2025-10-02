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

// Store PR information
interface PrInfo {
  head: string;
  base: string;
  number?: string;
  title?: string;
  currentBase?: string;
  status?: string;
}



export async function jjPr(revset: string, doIt: boolean = false) {
  // revset represents the set of new PR heads we want to create.
  // if a revision in the revset is already part of an existing PR,
  // we will update the base branch of that PR if needed.

  // if PRs not in the revset point to revisions in the revset,
  // we'll need to point their base branches to the new PRs.

  // Get all mutable commits in the revset (pass revset with '&' as one arg)
  const revArg = `${revset} & mutable()`;
  const heads = await getRevisionGraph(revArg);

  const headsToBranches = await Promise.all(
    heads.map(async (head) => {
      // Get the commit ID for the head
      // console.log("processing head", head.changeId);
      let headBranch = (
        await $`${JJ} bookmark list -r ${head.changeId} -T 'name ++ " " ++ remote ++ "\n"'`.text()
      ).trim();
      // console.log(
      //   "found bookmark(s) for head",
      //   head.changeId,
      //   ":",
      //   headBranch || "none"
      // );
      if (headBranch.includes("\n")) {
        /**
         * 
        multiple bookmarks found for head llzlrtsossmrktzmssvynsoporlyorru , using the first one
          ta/push/llzlrtsossmr-1
          ta/push/llzlrtsossmr-1 origin
         * 
         * this is expected. we have a remote and a local bookmark.
         * we should actually handle this more smartfully.
         */
        // console.log(
        //   "multiple bookmarks found for head",
        //   head.changeId,
        //   ", using the first one"
        // );
        // headBranch.split("\n").forEach((b) => {
        //   console.log("  ", b);
        // });
        headBranch = headBranch.split("\n")[0]!.trim();
      }
      return [head, headBranch || null] as const;
    })
  );

  // headsToBranches.forEach(([head, branch]) => {
  //   console.log('head:', head.changeId, 'branch:', branch === null ? 'none' : branch);
  // });

  // for heads where we need to make a branch:
  // * does a bookmark with the template alias 'git_push_bookmark' for this change exist?
  //   * if yes: does it point to this change, or a different one?
  //     * if the latter, it has been moved away. we shouldn't try to create one with the name.
  //        we can make a new one safely with a suffix.

  const headsWithBranchesProm = headsToBranches.map(async ([head, branch]) => {
    if (branch) return [head, branch] as const;

    // console.log("no bookmark found for head", head.changeId);

    const templated =
      await $`${JJ} log --no-graph -r ${head.changeId} -T 'git_push_bookmark'`.text();

    // maybe we could replace this with a stand-in name such as push/gen-xxxx
    assert(templated, "templated bookmark name should not be empty");

    const existingBookmarks = (
      await $`${JJ} bookmark list -T 'name ++ "\n"'`.text()
    )
      .trim()
      .split("\n");
    let existingBookmark: string | null = null;

    let attempt = 0;
    while (!existingBookmark) {
      const candidateName =
        attempt === 0 ? templated : templated + `-${attempt}`;
      if (!existingBookmarks.includes(candidateName)) {
        await $`${JJ} bookmark create ${candidateName} -r ${head.changeId}`.text();
        existingBookmark = candidateName;
        console.log(
          "created bookmark",
          candidateName,
          "for head",
          head.changeId
        );
        break;
      }
      attempt++;
    }
    return [head, existingBookmark] as const;
  });

  const headsWithBranches = await Promise.all(headsWithBranchesProm);

  headsWithBranches.forEach(([head, branch]) => {
    console.log("•", head.changeId.substring(0, 8), branch);
  });


  const prCreateProm = headsWithBranches.map(async ([head, branch]) => {
    await $`${JJ} git push --bookmark ${branch} --allow-new`.text();
    // console.log(head.changeId, "pushed to remote as", branch);
    const baseBranches =
      await $`${JJ} bookmark list -r "heads(::${head.changeId}- & bookmarks())" -T 'name ++ "\n"'`.text();
    // console.log("base branches for head", head.changeId, ":", baseBranches);
    const baseBranch = baseBranches.trim().split("\n")[0] || "main";

    if (branch === baseBranch) {
      console.log(
        "skipping PR creation for",
        branch,
        "->",
        baseBranch,
        "as they are the same"
      );
      return;
    }


    const prListOutput =
      await $`${GH} pr list --head ${branch} --json number,title,baseRefName`.text();
    const prList = prListFullSchema.parse(JSON.parse(prListOutput || "[]"));

    if (prList.length > 0) {
      const prData = prList[0];
      assert(prData, "PR data should exist");

      // Check if base branch needs updating
      if (prData.baseRefName !== baseBranch) {
        if (doIt) {
          await $`${GH} pr edit ${prData.number} --base ${baseBranch}`;
        } else {
          console.log(
            `[DRY RUN] Would update PR #${prData.number} base to ${baseBranch}`
          );
        }
      }
    } else {
      if (doIt) {
        console.log(`Creating PR for ${branch} -> ${baseBranch}`);
       const prResponse= await 
       Promise.race([
       $`${GH} pr create --head ${branch} --base ${baseBranch} --draft --fill`.text()
       ,
        new Promise<Error>((resolve) =>
          setTimeout(() => resolve(new Error("PR creation timed out")), 10000)
        )
       ]);
       console.log(prResponse);
      
      } else {
        console.log(
          `[DRY RUN] Would create PR for ${branch} -> ${baseBranch}`
        );
      }
    }
  });

  await Promise.all(prCreateProm);
  return;

  const prInfo = new Map<string, PrInfo>();

  for (const commitId of commitIds) {
    // Get the head bookmark name
    let headBranch = (
      await $`${JJ} bookmark list -r ${commitId} -T name`.text()
    ).trim();
    if (headBranch.includes("\n")) headBranch = headBranch.split("\n")[0]!;

    if (!headBranch) {
      // Create a bookmark for this commit if none exists
      headBranch = `push/gen-${Math.ceil(Math.random() * 123456).toString(16)}`;
      await $`${JJ} bookmark set ${headBranch} -r ${commitId}`;
    }

    // Ensure the head branch exists on the remote (safe to repeat)
    try {
      await $`${JJ} git push --branch ${headBranch} --allow-new`;
    } catch {}

    // Get base branch by asking for the closest bookmark (parent)
    const closestArg = `heads(::${commitId} & bookmarks())`;
    const baseBranches =
      await $`${JJ} bookmark list -r ${closestArg} -T name`.text();
    const baseBranch = baseBranches.trim().split("\n")[0] || "main";

    // Skip PRs where head equals base (e.g., main -> main)
    if (headBranch === baseBranch) {
      const info: PrInfo = {
        head: headBranch,
        base: baseBranch,
        status: "no change",
      };
      prInfo.set(commitId, info);
      continue;
    }

    const info: PrInfo = { head: headBranch, base: baseBranch };

    // Check if PR already exists
    const prListOutput =
      await $`${GH} pr list --head ${headBranch} --json number,title,baseRefName`.text();
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
        const newPrListOutput =
          await $`${GH} pr list --head ${headBranch} --json number,title`.text();
        const newPrList = prListLiteSchema.parse(
          JSON.parse(newPrListOutput || "[]")
        );
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

    console.log(
      `# ${number} ${title} ${info.head} -> ${info.base} (${status})`
    );
  }
}

interface RevisionInfo {
  changeId: string;
  parents: string[];
  children: string[];
}

export async function getRevisionGraph(
  revset: string
): Promise<RevisionInfo[]> {
  // Re-evaluate JJ command in case JJ_BIN was set after module load
  const JJ_CMD = process.env.JJ_BIN ? process.env.JJ_BIN.split(" ") : JJ;

  // Get all change IDs in the revset
  const changeIdsStr =
    await $`${JJ_CMD} log --no-graph -r ${revset} -T 'change_id ++ "\n"'`.text();
  const changeIds = changeIdsStr
    .trim()
    .split("\n")
    .filter((id) => id.length > 0);

  const results: RevisionInfo[] = [];

  for (const changeId of changeIds) {
    // Get parents for this specific revision
    const parentsStr =
      await $`${JJ_CMD} log --no-graph -r ${changeId} -T 'parents.map(|c| c.change_id() ++ "\n").join("")'`.text();
    const parents = parentsStr
      .trim()
      .split("\n")
      .filter((id) => id.length > 0);

    // Get children for this specific revision
    const childrenStr =
      await $`${JJ_CMD} log --no-graph -r 'children(${changeId})' -T 'change_id ++ "\n"'`.text();
    const children = childrenStr
      .trim()
      .split("\n")
      .filter((id) => id.length > 0);

    results.push({ changeId, parents, children });
  }

  return results;
}

if (require.main === module) {
  // Get revset from command line arguments (default to @)
  
  const doItIndex = process.argv.includes("--do-it") || process.argv.includes("-d");

  const doIt = doItIndex;
  const argv = process.argv.filter((arg) => arg !== "--do-it" && arg !== "-d");

  const revset = argv[2] || "@";

  await jjPr(revset, doIt);
}
