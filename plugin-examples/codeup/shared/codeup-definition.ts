import type { PluginForgeDefinition } from "@getpaseo/plugin";

// The client and server registrations must share the same provider identity.
export const codeupDefinition = {
  id: "codeup",
  displayName: "Codeup",
  changeRequestAbbrev: "MR",
  changeRequestNoun: "merge request",
  changeRequestNumberPrefix: "!",
  issueNumberPrefix: "#",
  signIn: { cli: "aliyun", command: "aliyun configure" },
  cloudHosts: ["codeup.aliyun.com"],
} satisfies PluginForgeDefinition;
