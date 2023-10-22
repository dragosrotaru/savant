import { app } from "@/app/domain/octokit";
import { requestCode, requestGPT } from "@/app/domain/openai";
import {
  findJestConfig,
  getContentsAndUnitTests,
  hasTypeScriptExtension,
  isSavantRepo,
  isSavantUserItself,
} from "../common";

// todo implement token length detection
// todo implement for updates to PR

app.webhooks.on("pull_request.opened", async (evt) => {
  // For a new PR, we want to write new Unit tests for any code which is new

  const { payload, octokit } = evt;
  const { pull_request } = payload;
  const { repository } = payload;
  const { owner } = repository;

  // todo create better branch names
  const branchName = "savant/tests-PR/" + pull_request.number;

  // Skip if push came from self, skip
  if (isSavantUserItself(payload.sender)) {
    console.log("PR from self, skipping");
    return;
  }

  // Skip if push is not on enabled repository
  // todo implement this, currently just for myself to prototype
  if (isSavantRepo(repository)) {
    console.log("PR on own repository, skipping");
    return;
  }

  if (pull_request.locked || pull_request.draft) {
    console.log("PR locked or draft, skipping");
    return;
  }

  const jestConfig = await findJestConfig(
    octokit,
    owner.login,
    repository.name
  );

  if (!jestConfig) {
    console.log("jest not detected, skipping");
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

  const newTests: { path: string; content: string; sha: string | undefined }[] =
    [];

  for (const file of files) {
    const { patch, status } = file;
    file;

    // Only typescript is supported
    if (!hasTypeScriptExtension(file.filename)) continue;
    if (status !== "modified" && status !== "added") continue;

    const content = await getContentsAndUnitTests(
      octokit,
      owner.login,
      repository.name,
      file.filename
    );
    if (!content) continue;

    // todo if tests exist for this code, lets get a coverage report and run again after to confirm increased coverage

    let prompt = `Write Jest unit tests for the code below. Return just a typescript code block with the Jest unit test file, assuming it is located next to the code in the directory. DO NOT INCLUDE PROSE:

    Code File:
    
    ${content.code.content}
      `;

    if (content.tests) {
      prompt = `Modify the Jest unit tests below to increase coverage of the following code. Return just a typescript code block with the Jest new unit test file. DO NOT INCLUDE PROSE:

      Code File:
      
      ${content.code.content}

      Unit Test File:

      ${content.tests}
        `;
    }

    const result = await requestCode(
      ["typescript"],
      "you are a senior software engineer who cares about code quality, reliability, security and performance. You are friendly and informative."
    )(prompt);

    if (!result.code) continue;

    // todo run tests and make sure they pass
    // todo get updated coverage report

    newTests.push({
      path: content.tests
        ? content.tests.path
        : file.filename.split(".")[0] + "spec.ts",
      content: result.code,
      sha: content.tests ? content.tests.sha : undefined,
    });
  }

  if (newTests.length === 0) {
    console.log("no fixes");
    return;
  }

  // Create a new branch off the branch pushed to)
  // todo handle error
  await octokit.rest.git.createRef({
    owner: owner.login,
    repo: repository.name,
    ref: `refs/heads/${branchName}`,
    sha: payload.pull_request.head.ref,
  });

  // Commit each change to the new branch
  // todo handle error
  for (const test of newTests) {
    // todo support different commit strategies (across files, single commit for all files)
    await octokit.rest.repos.createOrUpdateFileContents({
      owner: owner.login,
      repo: repository.name,
      path: test.path,
      // todo include message from chatgpt
      message: "Savant Fixes",
      content: Buffer.from(test.content).toString("base64"),
      branch: branchName,
      sha: test.sha,
    });
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
    base: payload.pull_request.base.ref || repository.default_branch,
  });

  // if the coverage is increased and the unit tests pass, create a branch, push to it, submit a PR and leave a comment
});

app.webhooks.on("pull_request.opened", async (evt) => {
  const { payload, octokit } = evt;
  const { pull_request } = payload;
  const { repository } = payload;
  const { owner } = repository;

  // Skip if push came from self, skip
  if (isSavantUserItself(payload.sender)) {
    console.log("PR from self, skipping");
    return;
  }

  // Skip if push is not on enabled repository
  // todo implement this, currently just for myself to prototype
  if (isSavantRepo(repository)) {
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
    if (!hasTypeScriptExtension(file.filename)) continue;
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
