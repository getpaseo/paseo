import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, unauthorized } from "@/lib/api-auth";
import { chatErrorResponse } from "@/lib/chat/http";
import { isOrgMember } from "@/lib/chat/authz";
import { db } from "@/lib/db";
import { ChatError } from "@/lib/chat/channels";
import { createPresignedUpload, uploadConfigFromEnv } from "@/lib/chat/uploads";

export async function POST(request: NextRequest) {
  const me = await authenticateRequest(request);
  if (!me) return unauthorized();

  const cfg = uploadConfigFromEnv();
  if (!cfg) {
    return NextResponse.json({ error: "Upload storage not configured" }, { status: 503 });
  }

  let body: {
    orgId?: string;
    filename?: string;
    mimeType?: string;
    sizeBytes?: number;
  } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (
    !body.orgId ||
    typeof body.filename !== "string" ||
    typeof body.mimeType !== "string" ||
    typeof body.sizeBytes !== "number"
  ) {
    return NextResponse.json(
      { error: "orgId, filename, mimeType, sizeBytes required" },
      { status: 400 },
    );
  }

  try {
    if (!(await isOrgMember(db, body.orgId, me.id))) {
      throw new ChatError("forbidden", "Not a member of this org");
    }
    const presigned = await createPresignedUpload(cfg, {
      userId: me.id,
      orgId: body.orgId,
      filename: body.filename,
      mimeType: body.mimeType,
      sizeBytes: body.sizeBytes,
    });
    return NextResponse.json(presigned, { status: 201 });
  } catch (err) {
    return chatErrorResponse(err);
  }
}
