import { NextResponse } from "next/server";
import { LibraryError } from "./entries";

export function libraryErrorResponse(err: unknown): NextResponse {
  if (err instanceof LibraryError) {
    const status =
      err.code === "not_found"
        ? 404
        : err.code === "forbidden"
          ? 403
          : err.code === "conflict"
            ? 409
            : err.code === "internal"
              ? 500
              : 400;
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error("[library] unexpected error", err);
  return NextResponse.json({ error: "Internal error" }, { status: 500 });
}
