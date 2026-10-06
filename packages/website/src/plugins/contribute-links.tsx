import { DOCS_URL, SUBMIT_URL } from "./links";

const LINK_CLASS =
  "text-sm text-extra-muted-foreground transition-colors hover:text-muted-foreground";
const PRIMARY_BUTTON_CLASS =
  "inline-flex items-center justify-center rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-foreground/90";
const SECONDARY_BUTTON_CLASS =
  "inline-flex items-center justify-center rounded-lg border border-white/12 px-4 py-2 text-sm text-white transition-colors hover:bg-white/10";

/** "Read the docs" and "Submit a plugin", as two quiet links. */
export function ContributeLinks() {
  return (
    <>
      <a href={DOCS_URL} className={LINK_CLASS}>
        Read the docs
      </a>
      <a href={SUBMIT_URL} className={LINK_CLASS}>
        Submit a plugin
      </a>
    </>
  );
}

/** Closing section of the directory: what a plugin can do, with Read the docs and Submit buttons. */
export function ContributeSection() {
  return (
    <section
      aria-labelledby="build-your-own"
      className="mt-20 rounded-xl border border-white/10 bg-white/[0.03] px-6 py-8 text-center sm:px-8"
    >
      <h2 id="build-your-own" className="text-lg font-medium">
        Build your own plugin
      </h2>
      <p className="mx-auto mt-2 max-w-lg text-sm text-muted-foreground">
        Plugins add themes, workspace panels, slash commands, and agent hooks to Paseo. Write one
        with the plugin docs, then submit it to get it listed here.
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <a href={DOCS_URL} className={PRIMARY_BUTTON_CLASS}>
          Read the docs
        </a>
        <a href={SUBMIT_URL} className={SECONDARY_BUTTON_CLASS}>
          Submit a plugin
        </a>
      </div>
    </section>
  );
}
