import { z } from "zod";

export const inputSchema = z.discriminatedUnion("store", [
  z.object({ store: z.literal("env"), locator: z.string().min(1) }).strict(),
  z
    .object({
      store: z.literal("login"),
      factoryDir: z.string().min(1),
      keyStore: z.enum(["keyring", "keychain", "file"]),
    })
    .strict(),
]);
export type UsageInput = z.infer<typeof inputSchema>;
export type LoginInput = Extract<UsageInput, { store: "login" }>;
export type KeyStore = LoginInput["keyStore"];
