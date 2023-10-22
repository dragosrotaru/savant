import { app } from "@/app/domain/octokit";
import { requestCode, requestGPT } from "@/app/domain/openai";
import { Repository, User, WebhookEventName } from "@octokit/webhooks-types";
import { NextRequest, NextResponse } from "next/server";
import { Octokit } from "octokit";

export const maxDuration = 60;

// Helper function to check if an array of file paths contains TypeScript files
const isTypeScriptFile = (filePath: string) => /\.(ts|tsx)$/i.test(filePath); // Regular expression to match TypeScript files

const isSavantUser = (user: User) => user.login === "savant-dev-ai";
const isSavantRepo = (repo: Repository) =>
  repo.owner.login === "dragosrotaru" && repo.name === "savant";

const isRefDefaultBranch = (ref: string, repo: Repository) =>
  ref === `refs/heads/${repo.default_branch}`;

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
  if (isSavantUser(payload.sender)) {
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

// todo implement for updates to PR

const findClosestToRoot = (filePaths: string[]): string | null => {
  if (filePaths.length === 0) return null;
  return filePaths.reduce(
    (closest, current) => {
      const currentSegments = current.split("/").length;
      if (currentSegments < closest.segments)
        return { path: current, segments: currentSegments };
      return closest;
    },
    { path: filePaths[0], segments: filePaths[0].split("/").length }
  ).path;
};

const findJestConfigFile = async (
  octokit: Octokit,
  owner: string,
  repo: string
) => {
  const query = `repo:${owner}/${repo} (filename:jest.config.js OR filename:jest.config.ts OR filename:jest.config.mjs OR filename:jest.config.cjs OR filename:jest.config.json)`;
  const { data } = await octokit.rest.search.code({
    q: query,
  });

  const path = findClosestToRoot(data.items.map((item) => item.path));
  if (!path) return false;
  const { data: file } = await octokit.rest.repos.getContent({
    owner,
    repo,
    path,
  });
  if (Array.isArray(file) || file.type !== "file") return false;

  return file.content;
};

const findPackageJSON = async (
  octokit: Octokit,
  owner: string,
  repo: string
) => {
  const { data } = await octokit.rest.repos.getContent({
    owner,
    repo,
    path: "package.json",
  });

  if (Array.isArray(data) || data.type !== "file") return false;

  return JSON.parse(data.content);
};

const findJestConfig = async (
  octokit: Octokit,
  owner: string,
  repo: string
) => {
  const pkg = await findPackageJSON(octokit, owner, repo);
  if (pkg.jest) return pkg.jest;
  const file = await findJestConfigFile(octokit, owner, repo);
  return file;
};

const getContentsAndUnitTests = async (
  octokit: Octokit,
  owner: string,
  repo: string,
  filePath: string
) => {
  const segments = filePath.split("/");
  const folder = segments.slice(0, -1).join("/");
  const name = segments.slice(-1, 0)[0].split(".")[0];

  const { data } = await octokit.rest.repos.getContent({
    owner,
    repo,
    path: folder,
  });

  if (!Array.isArray(data)) return false;

  const tests = data.filter(
    (file) =>
      file.path !== filePath &&
      file.name.split(".")[0] === name &&
      (file.name === `${name}.spec.ts` || file.name === `${name}.test.ts`)
  );

  return {
    tests: tests.length > 0 ? tests[0] : undefined,
    code: data.filter((file) => file.path === filePath)[0],
  };
};

app.webhooks.on("pull_request.opened", async (evt) => {
  // For a new PR, we want to write new Unit tests for any code which is new

  const { payload, octokit } = evt;
  const { pull_request } = payload;
  const { repository } = payload;
  const { owner } = repository;

  // todo create better branch names
  const branchName = "savant/tests-PR/" + pull_request.number;

  // Skip if push came from self, skip
  if (isSavantUser(payload.sender)) {
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
    if (!isTypeScriptFile(file.filename)) continue;
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
  if (isSavantUser(payload.sender)) {
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
