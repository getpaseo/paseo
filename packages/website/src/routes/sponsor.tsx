import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "~/components/site-shell";
import { pageMeta } from "~/meta";

export const Route = createFileRoute("/sponsor")({
  head: () =>
    pageMeta(
      "Sponsor Paseo",
      "Support the independent open-source project behind Paseo. Built by Mo, funded by the community.",
      "/sponsor",
    ),
  component: Sponsor,
});

function Sponsor() {
  return (
    <SiteShell width="default">
      <h1 className="text-3xl font-medium tracking-tight mb-8">Sponsor</h1>

      {/* Founder note */}
      <div className="space-y-6 text-white/70 leading-relaxed max-w-2xl">
        <p className="font-medium">
          Hey, I&apos;m{" "}
          <a
            href="https://github.com/boudra"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-white/80"
          >
            Mo
          </a>
          .
        </p>

        <p>
          Paseo started as a personal project: I wanted to run coding agents from anywhere without
          giving up control of my code, my keys, or my workflow. It grew into something bigger
          because developers felt the same need: a single place to orchestrate agents across
          devices, without vendor lock-in.
        </p>

        <p>
          I work on Paseo full-time. It&apos;s an independent, self-funded open-source project. I
          don&apos;t have investors, a board, or a big team. I&apos;m just shipping software the
          best I know how and hope it&apos;s useful to other people.
        </p>

        <p>
          Sponsorship is what makes that sustainable. It lets me stay focused on the product instead
          of chasing monetization, and it sends a clear signal that independent, open-source tools
          have a place in developer workflows.
        </p>

        <p>Thank you.</p>
      </div>

      {/* Sponsor links */}
      <section className="mt-12 space-y-4">
        <h2 className="text-xl font-medium">Support Paseo</h2>

        <div className="flex flex-col sm:flex-row gap-4">
          <a
            href="https://github.com/sponsors/boudra"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-4 rounded-xl border border-white/10 bg-white/[0.03] p-5 hover:border-white/20 hover:bg-white/[0.05] transition-colors"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="currentColor"
              className="text-white/60"
            >
              <path d="M12 0C5.37 0 0 5.484 0 12.252c0 5.418 3.438 10.013 8.205 11.637.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.738-4.042-1.61-4.042-1.61-.546-1.403-1.333-1.776-1.333-1.776-1.089-.756.084-.741.084-.741 1.205.087 1.838 1.262 1.838 1.262 1.07 1.87 2.809 1.33 3.495 1.017.108-.79.417-1.33.76-1.636-2.665-.31-5.467-1.35-5.467-6.005 0-1.327.465-2.413 1.235-3.262-.124-.31-.535-1.556.117-3.243 0 0 1.008-.33 3.3 1.248a11.2 11.2 0 0 1 3.003-.404c1.02.005 2.045.138 3.003.404 2.29-1.578 3.297-1.248 3.297-1.248.653 1.687.242 2.933.118 3.243.77.85 1.233 1.935 1.233 3.262 0 4.667-2.807 5.692-5.48 5.995.43.38.823 1.133.823 2.285 0 1.65-.015 2.98-.015 3.386 0 .315.218.694.825.576C20.565 22.26 24 17.667 24 12.252 24 5.484 18.627 0 12 0z" />
            </svg>
            <div>
              <p className="font-medium text-white">GitHub Sponsors</p>
            </div>
          </a>

          <a
            href="https://opencollective.com/paseo-ai/donate?interval=month&amount=10&contributeAs=me"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-4 rounded-xl border border-white/10 bg-white/[0.03] p-5 hover:border-white/20 hover:bg-white/[0.05] transition-colors"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="32"
              height="32"
              viewBox="0 0 39.98 40.05"
              className="text-white/60"
            >
              <path
                d="M32.76 19.97c0 2.53-.73 4.94-2 6.94l5.14 5.16c2.5-3.36 4.08-7.57 4.08-12.1 0-4.5-1.57-8.7-4.08-12.08l-5.13 5.16c1.26 2 2 4.3 2 6.93z"
                fill="currentColor"
              />
              <path
                d="M20 32.8c-7.02 0-12.78-5.78-12.78-12.83 0-7.04 5.76-12.82 12.77-12.82 2.6 0 4.9.73 6.9 2.1l5.13-5.15C28.68 1.58 24.5 0 20 0 9 0 0 8.94 0 20.08s9 19.97 20 19.97c4.6 0 8.8-1.57 12.14-4.1L27 30.8c-1.98 1.26-4.4 2-7 2z"
                fill="currentColor"
              />
            </svg>
            <div>
              <p className="font-medium text-white">Open Collective</p>
            </div>
          </a>

          <a
            href="https://buymeacoffee.com/paseo"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-4 rounded-xl border border-white/10 bg-white/[0.03] p-5 hover:border-white/20 hover:bg-white/[0.05] transition-colors"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="32"
              height="32"
              viewBox="0 0 24 24"
              className="text-white/60"
            >
              <path
                d="M20.216 6.415l-.132-.666c-.119-.598-.388-1.163-1.001-1.379-.197-.069-.42-.098-.57-.241-.152-.143-.196-.366-.231-.572-.065-.378-.125-.756-.192-1.133-.057-.325-.102-.69-.25-.987-.195-.4-.597-.634-.996-.788a5.723 5.723 0 00-.626-.194c-1-.263-2.05-.36-3.077-.416a25.834 25.834 0 00-3.7.062c-.915.083-1.88.184-2.75.5-.318.116-.646.256-.888.501-.297.302-.393.77-.177 1.146.154.267.415.456.692.58.36.162.737.284 1.123.366 1.075.238 2.189.331 3.287.37 1.218.05 2.437.01 3.65-.118.299-.033.598-.073.896-.119.352-.054.578-.513.474-.834-.124-.383-.457-.531-.834-.473-.466.074-.96.108-1.382.146-1.177.08-2.358.082-3.536.006a22.228 22.228 0 01-1.157-.107c-.086-.01-.18-.025-.258-.036-.243-.036-.484-.08-.724-.13-.111-.027-.111-.185 0-.212h.005c.277-.06.557-.108.838-.147h.002c.131-.009.263-.032.394-.048a25.076 25.076 0 013.426-.12c.674.019 1.347.067 2.017.144l.228.031c.267.04.533.088.798.145.392.085.895.113 1.07.542.055.137.08.288.111.431l.319 1.484a.237.237 0 01-.199.284h-.003c-.037.006-.075.01-.112.015a36.704 36.704 0 01-4.743.295 37.059 37.059 0 01-4.699-.304c-.14-.017-.293-.042-.417-.06-.326-.048-.649-.108-.973-.161-.393-.065-.768-.032-1.123.161-.29.16-.527.404-.675.701-.154.316-.199.66-.267 1-.069.34-.176.707-.135 1.056.087.753.613 1.365 1.37 1.502a39.69 39.69 0 0011.343.376.483.483 0 01.535.53l-.071.697-1.018 9.907c-.041.41-.047.832-.125 1.237-.122.637-.553 1.028-1.182 1.171-.577.131-1.165.2-1.756.205-.656.004-1.31-.025-1.966-.022-.699.004-1.556-.06-2.095-.58-.475-.458-.54-1.174-.605-1.793l-.731-7.013-.322-3.094c-.037-.351-.286-.695-.678-.678-.336.015-.718.3-.678.679l.228 2.185.949 9.112c.147 1.344 1.174 2.068 2.446 2.272.742.12 1.503.144 2.257.156.966.016 1.942.053 2.892-.122 1.408-.258 2.465-1.198 2.616-2.657.34-3.332.683-6.663 1.024-9.995l.215-2.087a.484.484 0 01.39-.426c.402-.078.787-.212 1.074-.518.455-.488.546-1.124.385-1.766zm-1.478.772c-.145.137-.363.201-.578.233-2.416.359-4.866.54-7.308.46-1.748-.06-3.477-.254-5.207-.498-.17-.024-.353-.055-.47-.18-.22-.236-.111-.71-.054-.995.052-.26.152-.609.463-.646.484-.057 1.046.148 1.526.22.577.088 1.156.159 1.737.212 2.48.226 5.002.19 7.472-.14.45-.06.899-.13 1.345-.21.399-.072.84-.206 1.08.206.166.281.188.657.162.974a.544.544 0 01-.169.364zm-6.159 3.9c-.862.37-1.84.788-3.109.788a5.884 5.884 0 01-1.569-.217l.877 9.004c.065.78.717 1.38 1.5 1.38 0 0 1.243.065 1.658.065.447 0 1.786-.065 1.786-.065.783 0 1.434-.6 1.499-1.38l.94-9.95a3.996 3.996 0 00-1.322-.238c-.826 0-1.491.284-2.26.613z"
                fill="currentColor"
              />
            </svg>
            <div>
              <p className="font-medium text-white">Buy Me a Coffee</p>
            </div>
          </a>
        </div>
      </section>
    </SiteShell>
  );
}
