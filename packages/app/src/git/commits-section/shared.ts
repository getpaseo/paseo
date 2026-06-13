import type { CheckoutCommit } from "@getpaseo/protocol/messages";

export type CheckoutCommitFile = CheckoutCommit["files"][number];

export type FilePressHandler = (commit: CheckoutCommit, file: CheckoutCommitFile) => void;
