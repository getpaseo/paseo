import { NextResponse } from "next/server";
import { ChatError } from "./channels";

export function chatErrorResponse(err: unknown): NextResponse {
  if (err instanceof ChatError) {
    const status =
      err.code === "not_found"
        ? 404
        : err.code === "forbidden" || err.code === "not_org_member"
          ? 403
          : err.code === "conflict"
            ? 409
            : 400;
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error("[chat] unexpected error", err);
  return NextResponse.json({ error: "Internal error" }, { status: 500 });
}
