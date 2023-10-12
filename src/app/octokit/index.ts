import fs from "fs";
import { App } from "octokit";
import path from "path";

const pemFilePath = path.join(
  process.cwd(),
  "savant-dev-ai.2023-10-12.private-key.pem"
);
const pemContent = fs.readFileSync(pemFilePath, "utf8");

const appId = process.env["GITHUB_APP_ID"];
const privateKey = pemContent;
const webhookSecret = process.env["GITHUB_WEBHOOK_SECRET"];

if (!appId || !privateKey || !webhookSecret) {
  throw new Error("github credentials are missing");
}
export const app = new App({
  appId,
  privateKey,
  webhooks: { secret: webhookSecret },
});
