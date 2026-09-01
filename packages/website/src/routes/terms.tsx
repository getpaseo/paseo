import { createFileRoute } from "@tanstack/react-router";
import { LegalPage, PaseoLegalIdentity } from "~/components/legal-page";
import { pageMeta } from "~/meta";

export const Route = createFileRoute("/terms")({
  head: () =>
    pageMeta(
      "Terms of Service - Paseo",
      "Terms for the official Paseo Relay and hosted Paseo Hub services.",
      "/terms",
    ),
  component: Terms,
});

function Terms() {
  return (
    <LegalPage title="Terms of Service" lastUpdated="August 29, 2026">
      <p>
        These Terms govern the official services operated at paseo.sh, relay.paseo.sh, and
        hub.paseo.sh. By using the official relay or hosted Hub, you agree to them. Our{" "}
        <a href="/privacy">Privacy Policy</a> explains how those services process data.
      </p>

      <section>
        <h2>Who provides the services</h2>
        <PaseoLegalIdentity />
      </section>

      <section>
        <h2>Paseo&apos;s open-source software</h2>
        <p>
          Paseo is open-source software licensed under the Apache License 2.0. You can install,
          modify, and self-host it under that license without purchasing Paseo Hub or using the
          official relay.
        </p>
        <p>
          These Terms do not replace or restrict the open-source license. They apply only to
          services operated by Paseo. A self-hosted Hub or relay is operated by whoever hosts it.
        </p>
      </section>

      <section>
        <h2>The official relay</h2>
        <p>
          The relay is an optional service that connects Paseo clients to your daemon without
          requiring you to expose the daemon directly. Traffic is encrypted end-to-end between your
          client and daemon. The relay carries encrypted data but cannot read its contents.
        </p>
        <p>
          The relay is subject to reasonable and fair use. We may limit bandwidth, connection
          volume, or abusive traffic when necessary to keep it reliable and secure.
        </p>
      </section>

      <section>
        <h2>Paseo Hub</h2>
        <p>
          Hub lets you connect daemons, configure workflows, receive events from connected services,
          and instruct agents running on your infrastructure. Hub does not provide AI inference.
        </p>
        <p>You are responsible for:</p>
        <ul>
          <li>The workflows, permissions, and connected services you configure</li>
          <li>The people you invite and the access you give them</li>
          <li>Actions performed by your agents and connected accounts</li>
          <li>Reviewing generated code and other agent output</li>
          <li>Maintaining backups of your repositories and local data</li>
        </ul>
      </section>

      <section>
        <h2>Your content</h2>
        <p>
          You keep ownership of your prompts, workflow configuration, code, messages, and outputs.
          You give Paseo only the permission needed to receive, transmit, store, and process that
          content to operate the services you request.
        </p>
        <p>We do not sell your content, use it for advertising, or use it to train AI models.</p>
      </section>

      <section>
        <h2>Accounts and teams</h2>
        <p>
          Keep your account credentials secure. Organization owners and administrators are
          responsible for invitations, permissions, connected services, and activity performed by
          their members. If you use Hub for an organization, you confirm that you are authorized to
          act for it and to process the data sent through its workflows.
        </p>
      </section>

      <section>
        <h2>Acceptable use</h2>
        <p>You must not use the services to:</p>
        <ul>
          <li>Break applicable law or infringe another person&apos;s rights</li>
          <li>Attack systems, distribute malware, or evade access controls</li>
          <li>Gain unauthorized access to another account, daemon, or service</li>
          <li>Interfere with the service or bypass reasonable usage limits</li>
          <li>Resell the official services without our written permission</li>
        </ul>
      </section>

      <section>
        <h2>Trials, subscriptions, and payment</h2>
        <p>
          Current prices, taxes, billing periods, and seat calculations are shown before purchase.
          Trial terms are shown when you start a trial. A no-card trial ends unless you add a valid
          payment method before it expires.
        </p>
        <p>
          Paid subscriptions renew automatically for the billing period shown at checkout until
          canceled. You can manage payment methods, invoices, and cancellation through the billing
          portal. Cancellation normally takes effect at the end of the current paid period. Payments
          are non-refundable except where the law requires otherwise.
        </p>
        <p>
          Stripe processes payments. Paseo does not store complete payment-card details. Nothing in
          these Terms removes cancellation, refund, withdrawal, or other rights given to you by
          applicable consumer law.
        </p>
      </section>

      <section>
        <h2>Third-party services</h2>
        <p>
          Paseo can connect to services such as GitHub, Slack, Discord, Linear, Anthropic, and
          OpenAI. Those services have their own terms and privacy policies. Paseo is not responsible
          for their availability, output, or handling of data.
        </p>
      </section>

      <section>
        <h2>Availability and changes</h2>
        <p>
          We work to keep the official relay and Hub available, but do not promise uninterrupted
          service or a service level unless we agree one in writing. We may change features,
          introduce reasonable limits, or suspend access when needed for security, abuse prevention,
          legal compliance, or operation of the service.
        </p>
        <p>
          Where practical, we will give reasonable notice before a change that materially reduces a
          paid service.
        </p>
      </section>

      <section>
        <h2>Suspension and termination</h2>
        <p>
          You may stop using the services or cancel your subscription at any time. We may suspend
          access for non-payment, serious abuse, security threats, or a material breach of these
          Terms. Where practical, we will explain the reason and allow you to correct it.
        </p>
      </section>

      <section>
        <h2>Warranty and liability</h2>
        <p>
          Software and automated agents can make mistakes. Review important actions and maintain
          appropriate backups.
        </p>
        <p>
          To the extent permitted by law, the official services are provided as available and
          without implied warranties. Paseo is not liable for indirect or consequential losses
          caused by agent output, third-party services, or your workflow configuration. Our total
          liability relating to a paid service will not exceed the amount you paid for it during the
          preceding 12 months.
        </p>
        <p>Nothing here limits liability or statutory rights that cannot legally be limited.</p>
      </section>

      <section>
        <h2>Governing law</h2>
        <p>
          These Terms are governed by Spanish law. If you are a consumer, you keep the mandatory
          protections and court rights provided by the law where you live.
        </p>
      </section>

      <section>
        <h2>Changes and contact</h2>
        <p>
          We may update these Terms as the services change. We will announce material changes
          through the service or by email where appropriate. Questions can be sent to{" "}
          <a href="mailto:hello@moboudra.com">hello@moboudra.com</a>.
        </p>
      </section>
    </LegalPage>
  );
}
