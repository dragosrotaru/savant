import { app } from "@/app/domain/octokit";
import { WebhookEventName } from "@octokit/webhooks-types";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

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
