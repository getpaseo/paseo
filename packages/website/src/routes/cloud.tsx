import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useState, type FormEvent } from "react";
import { submitCloudSignup, type CloudSignupInput } from "~/cloud-signup";
import { FAQItem } from "~/components/faq-item";
import { SiteShell } from "~/components/site-shell";
import { pageMeta } from "~/meta";

export const Route = createFileRoute("/cloud")({
  head: () => ({
    meta: pageMeta(
      "Paseo Cloud - Design Partners",
      "Paseo across machines, with a team, or inside a company. Looking for design partners.",
    ),
  }),
  component: Cloud,
});

const INPUT_CLASS =
  "block w-full rounded-md bg-white/5 border border-white/10 px-3.5 py-2.5 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-white/30 transition-colors";

type Status = "idle" | "submitting" | "success" | "error";

function Cloud() {
  return (
    <SiteShell>
      <h1 className="text-3xl font-medium mb-3">Paseo Cloud</h1>
      <p className="text-white/70 leading-relaxed mb-10">
        For using Paseo across machines, with a team, or inside a company. Looking for design
        partners.
      </p>

      <div className="space-y-20">
        <SignupForm />
        <FaqSection />
      </div>
    </SiteShell>
  );
}

function SignupForm() {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setStatus("submitting");
    setError(null);

    const form = new FormData(event.currentTarget);
    const data: CloudSignupInput = {
      email: String(form.get("email") ?? ""),
      name: form.get("name") ? String(form.get("name")) : undefined,
      company: form.get("company") ? String(form.get("company")) : undefined,
      role: form.get("role") ? String(form.get("role")) : undefined,
      message: String(form.get("message") ?? ""),
      honeypot: form.get("website") ? String(form.get("website")) : "",
    };

    try {
      await submitCloudSignup({ data });
      setStatus("success");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Something went wrong.");
    }
  }, []);

  if (status === "success") {
    return (
      <section className="space-y-3">
        <p className="text-white/70">
          Got it. I&apos;ll be in touch. If you don&apos;t hear back within a week, ping me on{" "}
          <a
            href="https://discord.gg/jz8T2uahpH"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-white/80"
          >
            Discord
          </a>
          .
        </p>
      </section>
    );
  }

  const submitting = status === "submitting";

  return (
    <form onSubmit={handleSubmit} className="space-y-6" noValidate>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
        <Field label="Email" required>
          <input type="email" name="email" required autoComplete="email" className={INPUT_CLASS} />
        </Field>
        <Field label="Name">
          <input type="text" name="name" autoComplete="name" className={INPUT_CLASS} />
        </Field>
        <Field label="Company">
          <input type="text" name="company" autoComplete="organization" className={INPUT_CLASS} />
        </Field>
        <Field label="Role">
          <input
            type="text"
            name="role"
            autoComplete="organization-title"
            className={INPUT_CLASS}
          />
        </Field>
      </div>

      <Field label="Message" required>
        <textarea
          name="message"
          required
          rows={5}
          placeholder="A bit about you and what you'd want from Paseo Cloud."
          className={`${INPUT_CLASS} resize-y`}
        />
      </Field>

      <input
        type="text"
        name="website"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="absolute left-[-9999px] w-px h-px opacity-0"
      />

      {error && (
        <p className="text-sm text-red-400">
          {error === "webhook not configured"
            ? "The form isn't wired up yet. Try Discord for now."
            : "Something went wrong. Try again or DM me on Discord."}
        </p>
      )}

      <div className="flex items-center gap-4 pt-4">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-white text-black px-4 py-2 text-sm font-medium hover:bg-white/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {submitting ? "Sending…" : "Send"}
        </button>
        <p className="text-sm text-white/50">
          Or{" "}
          <a
            href="https://discord.gg/jz8T2uahpH"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-white/80"
          >
            DM me on Discord
          </a>
          .
        </p>
      </div>
    </form>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-white/80 pb-2">
        {label}
        {required && <span className="text-white/40"> *</span>}
      </span>
      {children}
    </label>
  );
}

function FaqSection() {
  return (
    <section className="space-y-6">
      <h2 className="text-3xl font-medium">FAQ</h2>
      <div className="space-y-6">
        <FAQItem question="What is Paseo Cloud?">
          An optional layer on top of Paseo for running daemons across machines, syncing config
          between them, and using Paseo with a team or company. Think shared runners, permissions,
          audit, managed daemons, and org controls.
        </FAQItem>
        <FAQItem question="Will Paseo stay free and open source?">
          Yes. The whole stack stays free and open source: app, daemon, CLI, protocols, and the
          Cloud control plane. Managed Cloud is the optional paid layer for people who don&apos;t
          want to host it themselves.
        </FAQItem>
        <FAQItem question="Self-hosted or managed?">
          Both. The control plane will live in the Paseo monorepo so you can host it yourself.
          Managed is for people and teams who don&apos;t want to.
        </FAQItem>
        <FAQItem question="Does my code go through Paseo?">
          No. Daemons run on your machines and talk to agent providers directly. Cloud handles
          registration, config sync, permissions, and orchestration. Code and model traffic stay on
          your machines.
        </FAQItem>
        <FAQItem question="When will it be available?">
          Early access for design partners now. No public date. The app and daemon come first.
        </FAQItem>
        <FAQItem question="How does pricing work?">
          Not set yet. Design partners help shape it.
        </FAQItem>
      </div>
    </section>
  );
}
