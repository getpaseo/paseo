import { defineForgeServerProvider } from "@getpaseo/plugin/server";
import { createCodeupService } from "./codeup-service";
import { codeupDefinition } from "../shared/codeup-definition";

export const codeupServerProvider = defineForgeServerProvider({
  definition: codeupDefinition,
  service: createCodeupService(),
});
