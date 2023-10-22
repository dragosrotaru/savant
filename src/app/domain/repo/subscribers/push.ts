import { app } from "@/app/domain/octokit";
import { requestCode } from "@/app/domain/openai";
import {
  hasTypeScriptExtension,
  isRefDefaultBranch,
  isSavantRepo,
  isSavantUserItself,
} from "../common";

// todo implement token length detection

app.webhooks.on("push", async (evt) => {
  const { payload, octokit } = evt;
  const { commits } = payload;
  const { repository } = payload;
  const { owner } = repository;

  // todo create better branch names
  const branchName = "savant/quickfix/" + Date.now().toString();

  // Skip if push came from self, skip
  if (isSavantUserItself(payload.sender)) {
    console.log("push from self, skipping");
    return;
  }

  // Skip if push is not on enabled repository
  // todo implement this, currently just for myself to prototype
  if (isSavantRepo(repository)) {
    console.log("push on own repository, skipping");
    return;
  }

  // Skip if push is not on the default branch
  // todo allow user to set push based fixes on other branches
  if (!isRefDefaultBranch(payload.ref, repository)) {
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
      if (!hasTypeScriptExtension(path)) continue;

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
