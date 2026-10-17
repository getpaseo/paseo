import { expect, test } from "vitest";
import { TerminalImageError, terminalImageErrorCode } from "./terminal-image-error";
import { TerminalClipboardWriteImageResponseSchema } from "./messages";

test("classifies safe image errors without exposing private filesystem details", () => {
  expect(
    terminalImageErrorCode(
      Object.assign(new Error("ENOSPC /private/home/images/image.png"), { code: "ENOSPC" }),
    ),
  ).toBe("disk_full");
  expect(
    terminalImageErrorCode(
      Object.assign(new Error("EDQUOT /private/home/images/image.png"), { code: "EDQUOT" }),
    ),
  ).toBe("disk_full");
  expect(terminalImageErrorCode(new Error("EACCES /private/home/images/image.png"))).toBe(
    "upload_failed",
  );
  expect(terminalImageErrorCode(new TerminalImageError("quota_exceeded", "internal details"))).toBe(
    "quota_exceeded",
  );
});
test("accepts old image responses without an error code and new safe typed errors", () => {
  const legacy = {
    type: "terminal.clipboard.write_image.response",
    payload: { requestId: "old", success: false, error: "old private path" },
  };
  expect(TerminalClipboardWriteImageResponseSchema.parse(legacy)).toEqual(legacy);
  const current = {
    ...legacy,
    payload: { ...legacy.payload, error: "Unable to paste image", errorCode: "unsupported_mode" },
  };
  expect(TerminalClipboardWriteImageResponseSchema.parse(current)).toEqual(current);
});
