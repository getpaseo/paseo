import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "./fixtures";
import {
  assertChatTranscript,
  assertComposerIdle,
  assertFileContains,
  assertFileExists,
  assertFileMissing,
  cleanupRewindFlow,
  launchAgent,
  rewindMessage,
  sendMessage,
  type AgentHandle,
  type RewindFlowMode,
  type RewindFlowProvider,
} from "./helpers/rewind-flow";

const FILE_PROMPT = "Use the Write tool to create ./qa.txt with the exact content: PASEO_QA_TOKEN";

interface RewindFlowCase {
  provider: RewindFlowProvider;
  initialRewindMode?: RewindFlowMode;
  rewindMode: RewindFlowMode;
  fileReverted: boolean;
}

export function defineRewindFlowSpec(input: RewindFlowCase): void {
  test.describe(`rewind flow - ${input.provider}`, () => {
    test.setTimeout(600_000);

    test("rewinds conversation and file-write turns without transcript drift", async ({ page }) => {
      const cwd = realpathSync(
        mkdtempSync(path.join(tmpdir(), `paseo-rewind-flow-${input.provider}-`)),
      );
      let handle: AgentHandle | undefined;

      try {
        handle = await launchAgent({
          page,
          provider: input.provider,
          cwd,
          mode: "full-access",
        });

        await sendMessage(handle, "hello");
        await assertChatTranscript(handle, [
          { role: "user", text: "hello" },
          { role: "assistant", text: /.+/ },
        ]);

        await rewindMessage(handle, 0, input.initialRewindMode ?? "conversation");
        await assertChatTranscript(handle, []);
        await assertComposerIdle(handle);

        await sendMessage(handle, "hello");
        await assertChatTranscript(handle, [
          { role: "user", text: "hello" },
          { role: "assistant", text: /.+/ },
        ]);

        await sendMessage(handle, FILE_PROMPT);
        await assertFileContains(path.join(cwd, "qa.txt"), "PASEO_QA_TOKEN");
        await assertChatTranscript(handle, [
          { role: "user", text: "hello" },
          { role: "assistant", text: /.+/ },
          { role: "user", text: /Use the Write tool/ },
          { role: "assistant", text: /.+/ },
        ]);

        await rewindMessage(handle, 1, input.rewindMode);
        if (input.fileReverted) {
          await assertFileMissing(path.join(cwd, "qa.txt"));
        } else {
          await assertFileExists(path.join(cwd, "qa.txt"));
        }
        await assertChatTranscript(handle, [
          { role: "user", text: "hello" },
          { role: "assistant", text: /.+/ },
        ]);
        await assertComposerIdle(handle);
      } finally {
        await cleanupRewindFlow({ handle, cwd });
      }
    });
  });
}
