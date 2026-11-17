import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown, { type Components } from "react-markdown";
import {
  getChangelogReleaseGroups,
  releaseAnchor,
  type ChangelogRelease,
  type ChangelogReleaseGroup,
} from "~/changelog";
import { SiteShell } from "~/components/site-shell";
import { UntranslatedNotice } from "~/components/untranslated-notice";
import { formatDate, getTranslator, routeLocale, useLocale } from "~/i18n";
import { pageMeta } from "~/meta";

const patchMarkdownComponents: Components = { h3: "h4" };

export const Route = createFileRoute("/{-$locale}/changelog")({
  head: ({ params }) => {
    const locale = routeLocale(params);
    const t = getTranslator(locale);
    return pageMeta({
      title: t("changelog.metaTitle"),
      description: t("changelog.metaDescription"),
      path: "/changelog",
      locale,
    });
  },
  component: Changelog,
});

function HeadingAnchor({ version }: { version: string }) {
  const { t } = useTranslation();
  return (
    <a
      href={`#${releaseAnchor(version)}`}
      className="changelog-heading-anchor"
      aria-label={t("changelog.linkTo", { version })}
    >
      <span aria-hidden="true">#</span>
    </a>
  );
}

function ReleaseNotes({ release }: { release: ChangelogRelease }) {
  return (
    <>
      {release.highlights ? (
        <ReactMarkdown components={patchMarkdownComponents}>{release.highlights}</ReactMarkdown>
      ) : null}
      {release.sections ? (
        <ReactMarkdown components={patchMarkdownComponents}>{release.sections}</ReactMarkdown>
      ) : null}
    </>
  );
}

function PatchRelease({ release }: { release: ChangelogRelease }) {
  const { t } = useTranslation();
  const locale = useLocale();
  return (
    <section
      className="changelog-patch"
      aria-labelledby={`${releaseAnchor(release.version)}-title`}
    >
      <div id={releaseAnchor(release.version)} className="changelog-patch-heading">
        <HeadingAnchor version={release.version} />
        <h3 id={`${releaseAnchor(release.version)}-title`} className="changelog-patch-title">
          {release.version}
        </h3>
        <time dateTime={release.date} className="changelog-release-date">
          {formatDate(release.date, locale, "long")}
        </time>
      </div>
      <div className="changelog-release-notes" lang={release.locale}>
        <UntranslatedNotice
          contentLocale={release.locale}
          message={t("changelog.untranslatedRelease")}
        />
        <ReleaseNotes release={release} />
      </div>
    </section>
  );
}

function Patches({ group }: { group: ChangelogReleaseGroup }) {
  return (
    <div className="changelog-patches">
      {group.releases.map((release) => (
        <PatchRelease key={release.version} release={release} />
      ))}
    </div>
  );
}

/**
 * A minor version: its highlights, then every entry of it behind one control, newest first.
 * A minor without highlights shows its entries, since nothing stands in for them.
 */
function Release({ group }: { group: ChangelogReleaseGroup }) {
  const { t } = useTranslation();
  const locale = useLocale();
  return (
    <article
      className="changelog-release"
      aria-labelledby={`${releaseAnchor(group.version)}-title`}
    >
      <div id={releaseAnchor(group.version)} className="changelog-release-heading">
        <HeadingAnchor version={group.version} />
        <h2 id={`${releaseAnchor(group.version)}-title`} className="changelog-release-title">
          Paseo <span>{group.label}</span>
        </h2>
        <time dateTime={group.date} className="changelog-release-date">
          {formatDate(group.date, locale, "long")}
        </time>
      </div>
      {group.highlights ? (
        <>
          <div className="changelog-release-notes" lang={group.locale}>
            <UntranslatedNotice
              contentLocale={group.locale}
              message={t("changelog.untranslatedRelease")}
            />
            <ReactMarkdown components={patchMarkdownComponents}>{group.highlights}</ReactMarkdown>
          </div>
          {group.releases.some(hasNotes) ? (
            <details className="changelog-all-changes">
              <summary className="changelog-all-changes-summary">
                <span className="changelog-all-changes-show">{t("changelog.showAllChanges")}</span>
                <span className="changelog-all-changes-hide">{t("changelog.hideAllChanges")}</span>
              </summary>
              <Patches group={group} />
            </details>
          ) : null}
        </>
      ) : (
        <Patches group={group} />
      )}
    </article>
  );
}

function hasNotes(release: ChangelogRelease): boolean {
  return release.highlights !== "" || release.sections !== "";
}

/**
 * A link to one entry, such as `#release-0.16.1`, targets a heading inside its minor's closed
 * Show all changes block. Not every browser opens a closed `<details>` for a fragment link, so the
 * page opens the block and scrolls the entry into view.
 */
function useOpenLinkedEntry() {
  useEffect(() => {
    function openLinkedEntry() {
      const id = decodeURIComponent(window.location.hash.slice(1));
      const entry = id ? document.getElementById(id) : null;
      const block = entry?.closest("details");
      if (!entry || !block || block.open) return;
      block.open = true;
      entry.scrollIntoView();
    }
    openLinkedEntry();
    window.addEventListener("hashchange", openLinkedEntry);
    return () => window.removeEventListener("hashchange", openLinkedEntry);
  }, []);
}

function Changelog() {
  const { t } = useTranslation();
  const locale = useLocale();
  useOpenLinkedEntry();
  return (
    <SiteShell width="default">
      <div className="max-w-2xl">
        <h1 className="mb-12 text-3xl font-medium tracking-tight">{t("changelog.title")}</h1>
        {getChangelogReleaseGroups(locale).map((group) => (
          <Release key={group.version} group={group} />
        ))}
      </div>
    </SiteShell>
  );
}
