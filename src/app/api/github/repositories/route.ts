import { app } from "@/app/domain/octokit";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const installationId = searchParams.get("installation_id");
  if (installationId === null) {
    return NextResponse.error();
  }
  console.log("gatting the repositores");
  const install = await app.getInstallationOctokit(Number(installationId));
  const repos = await install.graphql(`{
    viewer {
      login
      repositories(first: 10) {
        nodes {
          name
        }
      }
    }
  }`);
  return NextResponse.json(repos);
}
