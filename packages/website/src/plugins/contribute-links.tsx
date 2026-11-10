import { useTranslation } from "react-i18next";
import { useLocalizePath } from "~/i18n";
import { DOCS_URL, SUBMIT_URL } from "./links";

const LINK_CLASS =
  "text-sm text-extra-muted-foreground transition-colors hover:text-muted-foreground";
const PRIMARY_BUTTON_CLASS =
  "inline-flex items-center justify-center rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-foreground/90";
const SECONDARY_BUTTON_CLASS =
  "inline-flex items-center justify-center rounded-lg border border-white/12 px-4 py-2 text-sm text-white transition-colors hover:bg-white/10";

/** "Read the docs" and "Submit a plugin", as two quiet links. */
export function ContributeLinks() {
  const { t } = useTranslation();
  const localize = useLocalizePath();
  return (
    <>
      <a href={localize(DOCS_URL)} className={LINK_CLASS}>
        {t("plugins.readDocs")}
      </a>
      <a href={SUBMIT_URL} className={LINK_CLASS}>
        {t("plugins.submit")}
      </a>
    </>
  );
}

/** "Submit a plugin" and "Read the docs", as a primary and a secondary button. */
export function ContributeButtons() {
  const { t } = useTranslation();
  const localize = useLocalizePath();
  return (
    <>
      <a href={SUBMIT_URL} className={PRIMARY_BUTTON_CLASS}>
        {t("plugins.submit")}
      </a>
      <a href={localize(DOCS_URL)} className={SECONDARY_BUTTON_CLASS}>
        {t("plugins.readDocs")}
      </a>
    </>
  );
}

/** Closing section of the directory: what a plugin can do, with Submit and Read the docs buttons. */
export function ContributeSection() {
  const { t } = useTranslation();
  return (
    <section
      aria-labelledby="build-your-own"
      className="mt-20 rounded-xl border border-white/10 bg-white/[0.03] px-6 py-8 text-center sm:px-8"
    >
      <h2 id="build-your-own" className="text-lg font-medium">
        {t("plugins.buildTitle")}
      </h2>
      <p className="mx-auto mt-2 max-w-lg text-sm text-muted-foreground">
        {t("plugins.buildDescription")}
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <ContributeButtons />
      </div>
    </section>
  );
}
