import { cancelAgent } from "../support/helpers/composer";
import {
  test,
  expectContinuousWordFade,
  expectSettledSelectableText,
} from "../support/helpers/word-stream-fade";

test("released words fade left to right and settle into selectable text", async ({
  streamingReply,
}, testInfo) => {
  await expectContinuousWordFade(streamingReply, testInfo);
  await cancelAgent(streamingReply);
  await expectSettledSelectableText(streamingReply);
});
