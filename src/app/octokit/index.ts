import { App } from "octokit";

const appId = process.env["GITHUB_APP_ID"];
const privateKey = process.env["GITHUB_PRIVATE_KEY"];
const webhookSecret = process.env["GITHUB_WEBHOOK_SECRET"];

if (!appId || !privateKey || !webhookSecret) {
  throw new Error("github credentials are missing");
}
export const app = new App({
  appId,
  privateKey,
  webhooks: { secret: webhookSecret },
});
