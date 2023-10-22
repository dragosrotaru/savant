import { Repository, User } from "@octokit/webhooks-types";

import { Octokit } from "octokit";

/*  Contents Logic */

/**
 * Returns true if the filepath has a valid TypeScript extension
 * @param filePath
 * @returns
 */
export const hasTypeScriptExtension = (filePath: string) =>
  /\.(ts|tsx|mts)$/i.test(filePath); // Regular expression to match TypeScript files

/**
 * Returns the file path closest to the root "/", or returns null if no paths are provided
 * @param filePaths
 * @returns
 */
export const closestPathToRoot = (filePaths: string[]): string | null => {
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

/**
 * Returns the parsed package.json file contents in the root of the project, if it exists. otherwise, returns false.
 * @param octokit
 * @param owner
 * @param repo
 * @returns
 */
export const findPackageJSON = async (
  octokit: Octokit,
  owner: string,
  repo: string
) => {
  const { data } = await octokit.rest.repos.getContent({
    owner,
    repo,
    path: "package.json",
  });

  if (Array.isArray(data) || data.type !== "file") return null;

  return JSON.parse(data.content);
};

/**
 * Searches for and returns the contents of top-most jest config file found in the repository
 * @param octokit
 * @param owner
 * @param repo
 * @returns
 */
export const findJestConfigFile = async (
  octokit: Octokit,
  owner: string,
  repo: string
) => {
  const query = `repo:${owner}/${repo} (filename:jest.config.js OR filename:jest.config.ts OR filename:jest.config.mjs OR filename:jest.config.cjs OR filename:jest.config.json)`;

  const { data } = await octokit.rest.search.code({
    q: query,
  });

  const path = closestPathToRoot(data.items.map((item) => item.path));

  if (!path) return null;

  const { data: file } = await octokit.rest.repos.getContent({
    owner,
    repo,
    path,
  });

  if (Array.isArray(file) || file.type !== "file") return null;

  return file;
};

/**
 * Searches for and returns the top-most jest config for a repository.
 * Only returns the first one found, package.json takes precedence.
 * @param octokit
 * @param owner
 * @param repo
 * @returns
 */
export const findJestConfig = async (
  octokit: Octokit,
  owner: string,
  repo: string
) => {
  const pkg = await findPackageJSON(octokit, owner, repo);
  if (pkg.jest) return pkg.jest;
  const file = await findJestConfigFile(octokit, owner, repo);
  if (file) return file.content;
  return null;
};

/**
 * Returns the code file and unit test file for a given filepath, using the assumed .spec.ts or .test.ts naming convention
 * @param octokit
 * @param owner
 * @param repo
 * @param filePath
 * @returns
 */
export const getContentsAndUnitTests = async (
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
    tests: tests.length > 0 ? tests[0] : null,
    code: data.filter((file) => file.path === filePath)[0],
  };
};

/* User and Repository Logic */

/**
 * Returns true of the user is the savant user itself
 * @param user
 * @returns
 */
export const isSavantUserItself = (user: User) =>
  user.login === "savant-dev-ai";

/**
 * Returns true if the repository is the savant repository itself
 * @param repo
 * @returns
 */
export const isSavantRepo = (repo: Repository) =>
  repo.owner.login === "dragosrotaru" && repo.name === "savant";

/**
 * Returns true if a ref points to the default branch of a repository
 * @param ref
 * @param repo
 * @returns
 */
export const isRefDefaultBranch = (ref: string, repo: Repository) =>
  ref === `refs/heads/${repo.default_branch}`;
