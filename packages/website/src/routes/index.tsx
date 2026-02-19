import * as React from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { CursorFieldProvider } from '~/components/butterfly'
import websitePackage from '../../package.json'
import '~/styles.css'

const desktopVersion = websitePackage.version
const macDownloadHref = `https://github.com/getpaseo/paseo/releases/download/v${desktopVersion}/Paseo_${desktopVersion}_aarch64.dmg`

export const Route = createFileRoute('/')({
  head: () => ({
    meta: [
      { title: 'Paseo – Manage coding agents from your phone and desktop' },
      {
        name: 'description',
        content:
          'A self-hosted daemon for Claude Code, Codex, and OpenCode. Agents run on your machine with your full dev environment. Connect from phone, desktop, or web.',
      },
    ],
  }),
  component: Home,
})

function Home() {
  return (
    <CursorFieldProvider>
      {/* Hero section with background image */}
      <div
        className="relative bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: 'url(/hero-bg.jpg)' }}
      >
        <div className="absolute inset-0 bg-background/90" />
        <div className="absolute inset-x-0 bottom-0 h-64 bg-gradient-to-t from-black to-transparent" />

        <div className="relative p-6 pb-10 md:px-20 md:pt-20 md:pb-12 max-w-3xl mx-auto">
          <Nav />
          <Hero />
          <GetStarted />
        </div>

        {/* Mockup - inside hero so it's above the gradient, positioned to overflow into black section */}
        <div className="relative px-6 md:px-8 pb-8 md:pb-16">
          <div className="max-w-6xl mx-auto">
            <img
              src="/paseo-mockup.png"
              alt="Paseo app showing agent management interface"
              className="w-full rounded-lg shadow-2xl"
            />
          </div>
        </div>
      </div>

      {/* Content section */}
      <div className="bg-black">
        <main className="p-6 md:p-20 md:pt-8 max-w-3xl mx-auto">
          <Features />
          <Story />
          <FAQ />
        </main>
        <footer className="p-6 md:p-20 md:pt-0 max-w-3xl mx-auto">
          <div className="border-t border-white/10 pt-6">
            <a
              href="/privacy"
              className="text-xs text-white/40 hover:text-white/60 transition-colors"
            >
              Privacy
            </a>
          </div>
        </footer>
      </div>
    </CursorFieldProvider>
  )
}

function Nav() {
  return (
    <nav className="flex items-center justify-between mb-16">
      <div className="flex items-center gap-3">
        <img src="/logo.svg" alt="Paseo" className="w-7 h-7" />
        <span className="text-lg font-medium">Paseo</span>
      </div>
      <div className="flex items-center gap-4">
        <a
          href="/docs"
          className="text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          Docs
        </a>
        <a
          href="/changelog"
          className="text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          Changelog
        </a>
        <a
          href="https://github.com/getpaseo/paseo"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="GitHub"
          className="text-muted-foreground hover:text-foreground transition-colors inline-flex items-center"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            fill="currentColor"
            viewBox="0 0 24 24"
          >
            <path d="M12 0C5.37 0 0 5.484 0 12.252c0 5.418 3.438 10.013 8.205 11.637.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.738-4.042-1.61-4.042-1.61-.546-1.403-1.333-1.776-1.333-1.776-1.089-.756.084-.741.084-.741 1.205.087 1.838 1.262 1.838 1.262 1.07 1.87 2.809 1.33 3.495 1.017.108-.79.417-1.33.76-1.636-2.665-.31-5.467-1.35-5.467-6.005 0-1.327.465-2.413 1.235-3.262-.124-.31-.535-1.556.117-3.243 0 0 1.008-.33 3.3 1.248a11.2 11.2 0 0 1 3.003-.404c1.02.005 2.045.138 3.003.404 2.29-1.578 3.297-1.248 3.297-1.248.653 1.687.242 2.933.118 3.243.77.85 1.233 1.935 1.233 3.262 0 4.667-2.807 5.692-5.48 5.995.43.38.823 1.133.823 2.285 0 1.65-.015 2.98-.015 3.386 0 .315.218.694.825.576C20.565 22.26 24 17.667 24 12.252 24 5.484 18.627 0 12 0z" />
          </svg>
        </a>
      </div>
    </nav>
  )
}

function Hero() {
  return (
    <div className="space-y-6">
      <h1 className="text-3xl md:text-5xl font-medium tracking-tight">
        Run Codex and Claude Code on your machine from your phone and desktop
      </h1>
      <p className="text-white/70 text-lg leading-relaxed">
        Bring your dev environment anywhere, with voice support built in.
      </p>
    </div>
  )
}

function Differentiator({
  title,
  description,
}: {
  title: string
  description: string
}) {
  return (
    <div>
      <p className="font-medium text-sm">{title}</p>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  )
}

function Features() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
        <Feature
          title="Self-hosted"
          description="The daemon runs on your laptop, home server, or VPS. Allowing you to take full advantage of your dev environment."
        />
        <Feature
          title="Multi-provider"
          description="Works with existing agent harnesses like Claude Code, Codex, and OpenCode from one interface."
        />
        <Feature
          title="Multi-host"
          description="Connect to multiple daemons and see all your agents in one place."
        />
        <Feature
          title="First-class voice"
          description="Real-time voice conversations and dictation. Talk to your agent, hear responses, and orchestrate work hands-free."
        />
        <Feature
          title="Optional relay"
          description="Use the hosted end-to-end encrypted relay for remote access, or connect directly over your network."
        />
        <Feature
          title="Cross-device"
          description="Jump seamlessly between iOS, Android, desktop, web, and CLI."
        />
        <Feature
          title="Git integration"
          description="Manage agents in isolated worktrees. Review diffs and ship directly from the app."
        />
        <Feature
          title="Open source"
          description="Free and open source. Run it yourself, fork it, contribute."
        />
      </div>
    </div>
  )
}

function Feature({
  title,
  description,
}: {
  title: string
  description: string
}) {
  return (
    <div className="space-y-1">
      <p className="font-medium text-base">{title}</p>
      <p className="text-sm text-white/60">{description}</p>
    </div>
  )
}

function GetStarted() {
  return (
    <div className="pt-10 space-y-4">
      <CodeBlock>npm install -g @getpaseo/cli && paseo</CodeBlock>
      <div className="flex flex-col sm:flex-row gap-3">
        <a
          href={macDownloadHref}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/20 px-4 py-2 text-sm font-medium text-white hover:bg-white/10 transition-colors"
        >
          <AppleIcon className="h-4 w-4" />
          Download for Mac
        </a>
        <a
          href="https://app.paseo.sh"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/20 px-4 py-2 text-sm font-medium text-white hover:bg-white/10 transition-colors"
        >
          <GlobeIcon className="h-4 w-4" />
          Launch Web App
        </a>
        <a
          href="https://testflight.apple.com/join/Y5HpSQjJ"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/20 px-4 py-2 text-sm font-medium text-white hover:bg-white/10 transition-colors"
        >
          <AppleIcon className="h-4 w-4" />
          iOS
        </a>
        <a
          href="https://docs.google.com/forms/d/e/1FAIpQLSfNU20RV0SnM_B9XOHTtMLv7fUWQkjsXH1d6ihZRGbHewCuOQ/viewform"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/20 px-4 py-2 text-sm font-medium text-white hover:bg-white/10 transition-colors"
        >
          <AndroidIcon className="h-4 w-4" />
          Android
        </a>
      </div>
    </div>
  )
}

function AppleIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 1408 1664"
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path d="M1393 1215q-39 125-123 250q-129 196-257 196q-49 0-140-32q-86-32-151-32q-61 0-142 33q-81 34-132 34q-152 0-301-259Q0 1144 0 902q0-228 113-374q113-144 284-144q72 0 177 30q104 30 138 30q45 0 143-34q102-34 173-34q119 0 213 65q52 36 104 100q-79 67-114 118q-65 94-65 207q0 124 69 223t158 126M1017 42q0 61-29 136q-30 75-93 138q-54 54-108 72q-37 11-104 17q3-149 78-257Q835 41 1011 0q1 3 2.5 11t2.5 11q0 4 .5 10t.5 10" />
    </svg>
  )
}

function AndroidIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 512 512"
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path d="M380.91,199l42.47-73.57a8.63,8.63,0,0,0-3.12-11.76,8.52,8.52,0,0,0-11.71,3.12l-43,74.52c-32.83-15-69.78-23.35-109.52-23.35s-76.69,8.36-109.52,23.35l-43-74.52a8.6,8.6,0,1,0-14.88,8.64L131,199C57.8,238.64,8.19,312.77,0,399.55H512C503.81,312.77,454.2,238.64,380.91,199ZM138.45,327.65a21.46,21.46,0,1,1,21.46-21.46A21.47,21.47,0,0,1,138.45,327.65Zm235,0A21.46,21.46,0,1,1,395,306.19,21.47,21.47,0,0,1,373.49,327.65Z" />
    </svg>
  )
}

function GlobeIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a15 15 0 0 1 0 18" />
      <path d="M12 3a15 15 0 0 0 0 18" />
    </svg>
  )
}

function Step({
  number,
  children,
}: {
  number: number
  children: React.ReactNode
}) {
  return (
    <div className="flex gap-4">
      <span className="flex-shrink-0 w-6 h-6 rounded-full bg-white/20 flex items-center justify-center text-xs font-medium">
        {number}
      </span>
      <div className="space-y-2 flex-1">{children}</div>
    </div>
  )
}

function CodeBlock({ children }: { children: React.ReactNode }) {
  const [copied, setCopied] = React.useState(false)
  const text = typeof children === 'string' ? children : ''

  function handleCopy() {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="bg-black/30 backdrop-blur-sm rounded-lg p-3 md:p-4 font-mono text-sm flex items-center justify-between gap-2">
      <div>
        <span className="text-muted-foreground select-none">$ </span>
        <span className="text-foreground">{children}</span>
      </div>
      <button
        onClick={handleCopy}
        className="text-muted-foreground hover:text-foreground transition-colors p-1"
        title="Copy to clipboard"
      >
        {copied ? (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            fill="currentColor"
            viewBox="0 0 256 256"
          >
            <path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z" />
          </svg>
        ) : (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            fill="currentColor"
            viewBox="0 0 256 256"
          >
            <path d="M216,28H88A20,20,0,0,0,68,48V76H40A20,20,0,0,0,20,96V216a20,20,0,0,0,20,20H168a20,20,0,0,0,20-20V188h28a20,20,0,0,0,20-20V48A20,20,0,0,0,216,28ZM164,212H44V100H164Zm48-48H188V96a20,20,0,0,0-20-20H92V52H212Z" />
          </svg>
        )}
      </button>
    </div>
  )
}

function Story() {
  return (
    <div className="pt-16 space-y-4">
      <h2 className="text-2xl font-medium">Background</h2>
      <div className="space-y-4 text-sm text-white/60">
        <p>
          I started using Claude Code soon after it launched, often on my phone
          while going on walks to spend less time at my desk. I'd SSH into Tmux
          from my phone. It worked, but the UX was rough. Dictation was bad, the
          virtual keyboard was awkward, and the TUI would randomly start
          flickering, which forced me to start over very often.
        </p>
        <p>
          I started building a simple app to manage agents via voice. I continued
          adding features as I needed them, and it slowly turned into what Paseo
          is today.
        </p>
        <p>
          Anthropic and OpenAI added coding agents to their mobile apps since I
          started working on this, but they force you into cloud sandboxes where
          you lose your whole setup. I also like testing different agents, so
          locking myself to a single harness or model wasn't an option.
        </p>
      </div>
    </div>
  )
}

function FAQ() {
  return (
    <div className="pt-16 space-y-6">
      <h2 className="text-2xl font-medium">FAQ</h2>
      <div className="space-y-6">
        <FAQItem question="Is this free?">
          Paseo is free and open source. It wraps CLI tools like Claude Code and
          Codex, which you'll need to have installed and configured with your
          own credentials. Voice is local-first by default and can optionally use
          OpenAI speech providers if you configure them.
        </FAQItem>
        <FAQItem question="Does my code leave my machine?">
          Paseo itself doesn't send your code anywhere. Agents run locally and
          communicate with their own APIs as they normally would. We provide an
          optional end-to-end encrypted relay for remote access, but you can
          also connect directly over your local network or use your own tunnel.
        </FAQItem>
        <FAQItem question="What agents does it support?">
          Claude Code, Codex, and OpenCode.
        </FAQItem>
        <FAQItem question="What's the business model?">There isn't one.</FAQItem>
        <FAQItem question="Isn't this just more screen time?">
          I won't pretend this can't be misused to squeeze every minute of your
          day into work. But for me it means less time at my desk, not more. I
          brainstorm whole features with voice. I kick off work at my desk, then
          check in from my phone during a walk. I see what an agent needs, send
          a voice reply, and put my phone away.
        </FAQItem>
        <FAQItem question="What does Paseo mean?">
          Stroll, in Spanish. 🚶‍♂️
        </FAQItem>
      </div>
    </div>
  )
}

function FAQItem({
  question,
  children,
}: {
  question: string
  children: React.ReactNode
}) {
  return (
    <details className="group">
      <summary className="font-medium text-sm cursor-pointer list-none flex items-start gap-2">
        <span className="font-mono text-white/40 group-open:hidden">+</span>
        <span className="font-mono text-white/40 hidden group-open:inline">
          -
        </span>
        {question}
      </summary>
      <div className="text-sm text-white/60 space-y-2 mt-2 ml-4">
        {children}
      </div>
    </details>
  )
}
