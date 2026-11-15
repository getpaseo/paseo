declare module "turndown-plugin-gfm" {
  import type TurndownService from "turndown";

  export const tables: TurndownService.Plugin;
  export const gfm: TurndownService.Plugin;
}
