import { createFileRoute } from "@tanstack/react-router";
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

function PatchRelease({ release }: { release: ChangelogRelease }) {
  const { t } = useTranslation();
  const locale = useLocale();
  return (
    <section className="changelog-patch">
      <div id={releaseAnchor(release.version)} className="changelog-patch-heading">
        <HeadingAnchor version={release.version} />
        <h3 className="changelog-patch-title">{release.version}</h3>
        <time dateTime={release.date} className="changelog-release-date">
          {formatDate(release.date, locale, "long")}
        </time>
      </div>
      <div className="changelog-release-notes" lang={release.locale}>
        <UntranslatedNotice
          contentLocale={release.locale}
          message={t("changelog.untranslatedRelease")}
        />
        <ReactMarkdown components={patchMarkdownComponents}>{release.markdown}</ReactMarkdown>
      </div>
    </section>
  );
}

function Release({ group }: { group: ChangelogReleaseGroup }) {
  return (
    <article className="changelog-release">
      <div id={releaseAnchor(group.version)} className="changelog-release-heading">
        <HeadingAnchor version={group.version} />
        <h2 className="changelog-release-title">
          Paseo <span>{group.version}</span>
        </h2>
      </div>
      <div className="changelog-patches">
        {group.releases.map((release) => (
          <PatchRelease key={release.version} release={release} />
        ))}
      </div>
    </article>
  );
}

function Changelog() {
  const { t } = useTranslation();
  const locale = useLocale();
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
