import { app } from "@/app/domain/octokit";
import { requestCode } from "@/app/domain/openai";
import { WebhookEventName } from "@octokit/webhooks-types";
import { NextRequest, NextResponse } from "next/server";

// Helper function to check if an array of file paths contains TypeScript files
function isTypeScriptFile(filePath: string) {
  const tsFileRegex = /\.(ts|tsx)$/i; // Regular expression to match TypeScript files
  return tsFileRegex.test(filePath);
}

export async function POST(req: NextRequest) {
  console.log("RECEIVED");
  try {
    app.webhooks.onError(() => {
      return NextResponse.error();
    });

    app.webhooks.on("push", async (evt) => {
      const { commits } = evt.payload;
      const { repository } = evt.payload;
      const { owner } = repository;
      const octokit = evt.octokit;

      // todo only continue if on repositories/branches enabled by user
      // todo only continue if rate limits not surpassed
      // todo only continue if user credits not consumed

      // Loop through the commits in the push event

      for (const commit of commits) {
        // todo also do for added files
        const { modified } = commit;

        const fixes: { path: string; content: string }[] = [];

        for (const path of modified) {
          // Only typescript is supported
          if (!isTypeScriptFile(path)) return;

          // Get the current file contents
          const content = await octokit.rest.repos.getContent({
            owner: owner.login,
            repo: repository.name,
            path: path,
          });

          // Get Changes to code by ChatGPT
          const result = await requestCode(
            ["typescript"],
            "be conservative in your changes"
          )(
            `fix any issues you notice in the code shown below. return ONLY THE CODE, inside of a codeblock. Return absolutely no prose. IF There are no fixes, return the original code:
                ${content}
              `
          );

          if (!result.code) return;

          const newContent = result.code;
          // todo iterate over the result using linting/compiler
          // todo track usage of tokens by user
          // todo check if changed, or implement better no change
          fixes.push({ path, content: newContent });
        }

        // todo create better branch names
        const branchName = "savant/quickfix"; // Name of the branch for the fix

        // Create a new branch based on the default branch (e.g., 'main')
        await octokit.rest.git.createRef({
          owner: owner.login,
          repo: repository.name,
          ref: `refs/heads/${branchName}`,
          sha: evt.payload.ref, // Use the commit SHA from the push event
        });

        for (const fix of fixes) {
          // Commit the changes to the new branch
          // todo implement different commit strategies
          await octokit.rest.repos.createOrUpdateFileContents({
            owner: owner.login,
            repo: repository.name,
            path: fix.path,
            // todo include descriptive name changes
            message: "Fix TypeScript bug",
            content: fix.content,
            branch: branchName,
          });
        }

        // Create a pull request
        const pullRequest = await octokit.rest.pulls.create({
          owner: owner.login,
          repo: repository.name,
          // todo better title
          title: "Fix TypeScript Bug",
          // todo write descriptive PR
          // todo write PR according to templates
          head: branchName,
          // todo use branch specified by user and/or default branch
          base: "main",
        });
      }
    });

    await app.webhooks.verifyAndReceive({
      id: req.headers.get("x-github-delivery") ?? "",
      signature: req.headers.get("x-hub-signature-256") ?? "",
      name: req.headers.get("x-github-event") as WebhookEventName,
      payload: await req.text(),
    });
  } catch (error) {
    return NextResponse.error();
  }
}
