declare module "js-yaml" {
  export interface LoadOptions {
    readonly filename?: string;
    readonly json?: boolean;
  }

  export function load(input: string, options?: LoadOptions): unknown;

  const yaml: {
    readonly load: typeof load;
  };
  export default yaml;
}
