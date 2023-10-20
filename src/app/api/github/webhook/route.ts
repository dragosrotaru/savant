import { app } from "@/app/domain/octokit";
import { requestCode, requestGPT } from "@/app/domain/openai";
import { WebhookEventName } from "@octokit/webhooks-types";
import { NextRequest, NextResponse } from "next/server";

// Helper function to check if an array of file paths contains TypeScript files
function isTypeScriptFile(filePath: string) {
  const tsFileRegex = /\.(ts|tsx)$/i; // Regular expression to match TypeScript files
  return tsFileRegex.test(filePath);
}

app.webhooks.onError(console.log);

// todo implement token length detection

app.webhooks.on("push", async (evt) => {
  const { payload, octokit } = evt;
  const { commits } = payload;
  const { repository } = payload;
  const { owner } = repository;

  // todo create better branch names
  const branchName = "savant/quickfix/" + Date.now().toString();

  // Skip if push came from self, skip
  if (payload.sender.login === "savant-dev-ai") {
    console.log("push from self, skipping");
    return;
  }

  // Skip if push is not on enabled repository
  // todo implement this, currently just for myself to prototype
  if (
    repository.owner.login === "dragosrotaru" &&
    repository.name === "savant"
  ) {
    console.log("push on own repository, skipping");
    return;
  }

  // Skip if push is not on the default branch
  if (!(payload.ref === `refs/heads/${repository.default_branch}`)) {
    // todo allow user to set push based fixes on other branches
    console.log("push not on default branch, skipping");
    return;
  }

  // todo only continue if user or openai imposed rate limits not surpassed
  // todo only continue if user credits not consumed

  // Loop through the commits in the push event and retrieve fixes
  for (const commit of commits) {
    const { modified, added } = commit;
    const files = [...modified, ...added];
    const fixes: { path: string; content: string; sha: string }[] = [];

    for (const path of files) {
      // Only typescript is supported
      if (!isTypeScriptFile(path)) continue;

      // Get the current file contents
      const { data } = await octokit.rest.repos.getContent({
        owner: owner.login,
        repo: repository.name,
        path,
      });
      // todo handle error

      if (Array.isArray(data) || data.type !== "file") continue;

      const oldContent = data.content;
      const sha = data.sha;

      // Get Changes to code by ChatGPT
      // todo implement user selectable change prompts
      // todo ask for a commit message incorporated in the response to extract
      // todo handle error
      const result = await requestCode(
        ["typescript"],
        "return modern typescript code"
      )(
        `fix all code quality/readabiliy issues, spelling errors, typos or bugs that exist in the code shown below. return only the code, inside of a typescript codeblock. Return absolutely no prose. if there are no fixes, return the phrase "No Fixes":
            ${oldContent}
          `
      );
      // todo track usage of tokens by user
      if (!result.code) continue;
      // todo iterate over the result using linting/compiler
      fixes.push({ path, content: result.code, sha });
    }

    if (fixes.length === 0) {
      console.log("no fixes");
      return;
    }

    // Create a new branch off the branch pushed to)
    // todo handle error
    await octokit.rest.git.createRef({
      owner: owner.login,
      repo: repository.name,
      ref: `refs/heads/${branchName}`,
      sha: payload.after,
    });

    // Commit each change to the new branch
    // todo handle error
    for (const fix of fixes) {
      // todo support different commit strategies (across files, single commit for all files)
      await octokit.rest.repos.createOrUpdateFileContents({
        owner: owner.login,
        repo: repository.name,
        path: fix.path,
        // todo include message from chatgpt
        message: "Savant Fixes",
        content: Buffer.from(fix.content).toString("base64"),
        branch: branchName,
        sha: fix.sha,
      });
    }
  }

  // Create a pull request
  await octokit.rest.pulls.create({
    owner: owner.login,
    repo: repository.name,
    // todo better title
    title: "Savant Fixes",
    // todo write descriptive PR
    // todo write PR according to templates
    head: branchName,
    base: payload.base_ref || repository.default_branch,
  });
});

// todo implement for updates to repo

app.webhooks.on("pull_request.opened", async (evt) => {
  const { payload, octokit } = evt;
  const { pull_request } = payload;
  const { repository } = payload;
  const { owner } = repository;

  // Skip if push came from self, skip
  if (payload.sender.login === "savant-dev-ai") {
    console.log("PR from self, skipping");
    return;
  }

  // Skip if push is not on enabled repository
  // todo implement this, currently just for myself to prototype
  if (
    repository.owner.login === "dragosrotaru" &&
    repository.name === "savant"
  ) {
    console.log("PR on own repository, skipping");
    return;
  }

  if (pull_request.locked || pull_request.draft) {
    console.log("PR locked or draft, skipping");
    return;
  }

  const {
    data: { files },
  } = await octokit.rest.repos.compareCommits({
    owner: owner.login,
    repo: repository.name,
    base: pull_request.base.sha,
    head: pull_request.head.sha,
  });

  if (!files || files.length === 0) {
    console.log("no files changes, skipping");
    return;
  }

  for (const file of files) {
    const { patch, status } = file;

    // Only typescript is supported
    if (!isTypeScriptFile(file.filename)) continue;
    if (status !== "modified" && status !== "added") continue;
    if (!patch) continue;

    const result = await requestGPT(
      "you are a senior software engineer who cares about code quality, reliability, security and performance. You are friendly and informative."
    )(
      `write a code review for the following patch of a Pull Request:

      title: ${pull_request.title}

      body: ${pull_request.body}
      
      code patch:
          ${patch}
        `
    );

    if (!result.content) continue;

    await octokit.rest.pulls.createReviewComment({
      owner: owner.login,
      repo: repository.name,
      pull_number: pull_request.number,
      commit_id: pull_request.head.sha,
      path: file.filename,
      body: result.content,
      line: patch.split("\n").length - 1,
    });
  }
});

export async function POST(req: NextRequest) {
  try {
    const id = req.headers.get("X-GitHub-Delivery");
    const name = req.headers.get("X-GitHub-Event");
    const payload = JSON.stringify(await req.json());
    const signature = req.headers.get("X-Hub-Signature-256");

    if (!id || !name || !payload || !signature) {
      throw new Error(
        `missing webhook contents: ${id}, ${name}, ${payload}, ${signature}`
      );
    }

    await app.webhooks.verifyAndReceive({
      id,
      name: name as WebhookEventName,
      payload,
      signature,
    });
    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error: any) {
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
