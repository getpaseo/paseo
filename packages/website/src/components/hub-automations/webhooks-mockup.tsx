import { ArrowDown, Check, Terminal, Webhook } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import {
  MockupStageWindow,
  MockupStep,
  OpenInPaseoChip,
  PaseoBotAvatar,
  type SourceMockupProps,
  WindowTrafficLights,
} from "./shared";

const STEP_DELAYS = {
  curl: 0.06,
  response: 0.65,
  runCard: 1.25,
} as const;

const WEBHOOK_ID = "wh_4PCfLx4q46HniZpIeiThI4BmNC4zHGFY";
const RUN_ID = "0197e5d2-a70c-4ad0-b7aa-a29154a6bc72";
const ACCEPTED_RESPONSE = JSON.stringify({ status: "accepted", runId: RUN_ID });

const WEBHOOK_COMPONENTS = {
  code: <code className="font-mono text-[11px] text-white/90" />,
  pr: <span className="font-mono text-[#6CB17B]">#2834</span>,
};

export function WebhooksSourceMockup({ active, reduceMotion }: SourceMockupProps) {
  const { t } = useTranslation();

  return (
    <MockupStageWindow
      ariaLabel={t("hub.demo.webhooks.alt")}
      active={active}
      reduceMotion={reduceMotion}
      className="border-white/[0.1] bg-[#0C1110]"
    >
      <WebhookTerminalChrome />

      <div className="flex flex-1 flex-col justify-between gap-2.5 p-4">
        <div className="space-y-3">
          <WebhookCurlBlock />
          <WebhookResponseBlock />
        </div>
        <WebhookRouteConnector />
        <WebhookRunCard />
      </div>
    </MockupStageWindow>
  );
}

function WebhookTerminalChrome() {
  return (
    <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-white/[0.08] bg-[#131918] px-3.5">
      <div className="flex min-w-0 items-center gap-3">
        <WindowTrafficLights />
        <span className="inline-flex min-w-0 items-center gap-1.5 truncate font-mono text-[11.5px] text-white/65">
          <Terminal className="h-3.5 w-3.5 shrink-0 text-white/45" aria-hidden="true" />
          <span className="truncate">mo@devbox — zsh</span>
        </span>
      </div>
      <span className="hidden shrink-0 items-center gap-1.5 rounded border border-white/10 bg-white/[0.04] px-2 py-0.5 font-mono text-[10.5px] text-accent-text sm:inline-flex">
        <Webhook className="h-3 w-3" aria-hidden="true" />
        POST /webhooks/{WEBHOOK_ID}
      </span>
    </div>
  );
}

function WebhookRouteConnector() {
  const { t } = useTranslation();
  return (
    <MockupStep delay={0.95} className="flex items-center gap-2.5 px-1 text-[11px] text-white/45">
      <span className="h-px flex-1 bg-white/[0.07]" aria-hidden="true" />
      <span className="inline-flex items-center gap-1.5 font-mono text-accent-text/90">
        <ArrowDown className="h-3 w-3" aria-hidden="true" />
        {t("hub.demo.webhooks.routedLine")}
      </span>
      <span className="h-px flex-1 bg-white/[0.07]" aria-hidden="true" />
    </MockupStep>
  );
}

function WebhookCurlBlock() {
  return (
    <MockupStep delay={STEP_DELAYS.curl}>
      <pre className="font-mono text-[11.5px] leading-[1.6] wrap-anywhere whitespace-pre-wrap text-white/80">
        <code>
          <span className="select-none text-accent-text">$ </span>
          <span className="text-white">curl</span> <span className="text-sky-300/90">-X POST</span>{" "}
          <span className="text-emerald-300/90">
            https://hub.paseo.sh/webhooks/
            <wbr />
            {WEBHOOK_ID}
          </span>{" "}
          <span className="text-white/35">\</span>
          {"\n"}
          {"  "}
          <span className="text-sky-300/90">-H</span>{" "}
          <span className="text-amber-200/85">
            &quot;Authorization: Bearer $WEBHOOK_TOKEN&quot;
          </span>{" "}
          <span className="text-white/35">\</span>
          {"\n"}
          {"  "}
          <span className="text-sky-300/90">-H</span>{" "}
          <span className="text-amber-200/85">&quot;Content-Type: application/json&quot;</span>{" "}
          <span className="text-white/35">\</span>
          {"\n"}
          {"  "}
          <span className="text-sky-300/90">-d</span>{" "}
          <span className="text-white/75">
            &#39;&#123;&quot;error&quot;:&quot;ECONNRESET&quot;&#125;&#39;
          </span>
        </code>
      </pre>
    </MockupStep>
  );
}

function WebhookResponseBlock() {
  return (
    <MockupStep
      delay={STEP_DELAYS.response}
      className="rounded-lg border border-brand-green/35 bg-brand-green/[0.08] px-3 py-2 font-mono text-[11.5px] leading-[1.55]"
    >
      <div className="flex items-center gap-2 text-[#6CB17B]">
        <span className="font-semibold">HTTP/2 202 Accepted</span>
        <span className="text-white/35">·</span>
        <span className="text-white/55">42ms</span>
      </div>
      <div className="mt-0.5 wrap-anywhere text-white/80">{ACCEPTED_RESPONSE}</div>
    </MockupStep>
  );
}

function WebhookRunCard() {
  const { t } = useTranslation();
  return (
    <MockupStep
      delay={STEP_DELAYS.runCard}
      className="rounded-lg border border-white/[0.09] bg-[#141B19] p-3.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.07] pb-2.5">
        <div className="flex items-center gap-2">
          <PaseoBotAvatar size="sm" />
          <div>
            <div className="flex items-center gap-1.5 text-[12.5px]">
              <span className="font-semibold text-white/95">paseo-bot</span>
              <span className="font-mono text-[11px] text-white/45">{RUN_ID.slice(0, 8)}…</span>
            </div>
            <p className="text-[11px] text-white/55">{t("hub.demo.webhooks.runMeta")}</p>
          </div>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-brand-green/50 bg-brand-green/20 px-2 py-0.5 text-[10.5px] font-medium text-accent-text">
          <span className="h-1.5 w-1.5 rounded-full bg-[#35C264]" />
          {t("hub.demo.webhooks.statusDone")}
        </span>
      </div>

      <ul className="mt-2.5 space-y-1.5 text-[12px] text-white/75">
        <li className="flex items-start gap-2">
          <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-text" aria-hidden="true" />
          <span>
            <Trans i18nKey="hub.demo.webhooks.trace1" components={WEBHOOK_COMPONENTS} />
          </span>
        </li>
        <li className="flex items-start gap-2">
          <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-text" aria-hidden="true" />
          <span>
            <Trans i18nKey="hub.demo.webhooks.trace2" components={WEBHOOK_COMPONENTS} />
          </span>
        </li>
        <li className="flex items-start gap-2">
          <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-text" aria-hidden="true" />
          <span>
            <Trans i18nKey="hub.demo.webhooks.trace3" components={WEBHOOK_COMPONENTS} />
          </span>
        </li>
      </ul>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.07] pt-2.5">
        <OpenInPaseoChip variant="brand" />
        <span className="font-mono text-[11px] text-white/45">
          {t("hub.demo.webhooks.triggeredBy")}
        </span>
      </div>
    </MockupStep>
  );
}
