import type { ReactNode } from "react";
import { SiteShell } from "~/components/site-shell";

interface LegalPageProps {
  title: string;
  lastUpdated: string;
  children: ReactNode;
}

export function LegalPage({ title, lastUpdated, children }: LegalPageProps) {
  return (
    <SiteShell width="prose">
      <article className="space-y-8 text-white/70 leading-relaxed [&_a]:underline [&_a]:underline-offset-2 [&_a:hover]:text-white [&_h2]:text-xl [&_h2]:font-medium [&_h2]:text-white [&_li]:pl-1 [&_section]:space-y-3 [&_ul]:ml-5 [&_ul]:list-disc [&_ul]:space-y-1">
        <header className="space-y-3">
          <h1 className="text-3xl font-medium text-white">{title}</h1>
          <p className="text-sm text-white/50">Last updated: {lastUpdated}</p>
        </header>
        {children}
      </article>
    </SiteShell>
  );
}

export function PaseoLegalIdentity() {
  return (
    <address className="not-italic">
      <strong className="font-medium text-white">Mohamed Boudra Ziani</strong>, operating as Paseo
      <br />
      NIF/VAT ID: ES26617095T
      <br />
      Roc Boronat 48, Bajos 2
      <br />
      08005 Barcelona, Spain
      <br />
      Email: <a href="mailto:hello@moboudra.com">hello@moboudra.com</a>
    </address>
  );
}
