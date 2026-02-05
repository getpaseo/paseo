import { createFileRoute } from '@tanstack/react-router'
import { CursorFieldProvider, FloatingButterfly } from '~/components/butterfly'
import '~/styles.css'

export const Route = createFileRoute('/')({
  head: () => ({
    meta: [
      { title: 'Paseo – Run coding agents on your machines, from desktop and phone' },
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
        className="relative min-h-[80vh] bg-cover bg-center bg-no-repeat overflow-hidden"
        style={{ backgroundImage: 'url(/hero-bg.jpg)' }}
      >
        <div className="absolute inset-0 bg-background/80" />
        <div className="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-black to-transparent" />

        {/* Left side butterflies - facing right */}
        <FloatingButterfly
          style={{ left: '5%', top: '15%' }}
          size={38}
          color="#e8976b"
          delay={0}
          duration={0.45}
          direction="right"
        />
        <FloatingButterfly
          style={{ left: '8%', top: '45%' }}
          size={30}
          color="#f0c75e"
          delay={0.3}
          duration={0.55}
          direction="right"
        />
        <FloatingButterfly
          style={{ left: '3%', top: '70%' }}
          size={34}
          color="#d4728a"
          delay={0.15}
          duration={0.5}
          direction="left"
        />

        {/* Right side butterflies - facing left */}
        <FloatingButterfly
          style={{ right: '6%', top: '20%' }}
          size={32}
          color="#f5d86a"
          delay={0.2}
          duration={0.6}
          direction="left"
        />
        <FloatingButterfly
          style={{ right: '4%', top: '55%' }}
          size={40}
          color="#e07850"
          delay={0.1}
          duration={0.4}
          direction="left"
        />

        <div className="relative p-5 md:p-16 max-w-2xl mx-auto">
          <Nav />
          <Hero />
          <GetStarted />
        </div>
      </div>

      {/* Content section with black background */}
      <div className="bg-black">
        <main className="p-5 md:p-16 max-w-2xl mx-auto">
          <Features />
          <FAQ />
          <Footer />
        </main>
      </div>
    </CursorFieldProvider>
  )
}

function Nav() {
  return (
    <nav className="flex items-center justify-between mb-16">
      <div className="flex items-center gap-3">
        <img src="/logo.svg" alt="Paseo" className="w-7 h-7" />
        <span className="text-lg font-medium">paseo</span>
      </div>
      <div className="flex items-center gap-4">
        <a
          href="/docs"
          className="text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          Docs
        </a>
        <a
          href="https://github.com/moboudra/paseo"
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          GitHub
        </a>
      </div>
    </nav>
  )
}

function Hero() {
  return (
    <div className="space-y-6">
      <h1 className="text-4xl md:text-5xl font-medium tracking-tight font-serif">
        Manage coding agents from your phone and desktop.
      </h1>
      <p className="text-white/70 text-lg leading-relaxed">
        Agents run on your machine with your full dev environment. Connect from
        phone, desktop, or web.
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
          title="Voice input"
          description="Dictate prompts when you're away from your keyboard."
        />
        <Feature
          title="Optional relay"
          description="Use the hosted end-to-end encrypted relay for remote access, or connect directly over your network."
        />
        <Feature
          title="Cross-device"
          description="Jump seamlessly between iOS, Android, desktop, web, and CLI."
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
      <p className="font-medium text-sm">{title}</p>
      <p className="text-sm text-white/60">{description}</p>
    </div>
  )
}

function GetStarted() {
  return (
    <div className="pt-10 space-y-6">
      <div className="space-y-4">
        <Step number={1}>
          <p className="text-sm">Install and run the daemon</p>
          <CodeBlock>npm install -g @getpaseo/cli && paseo</CodeBlock>
        </Step>
        <Step number={2}>
          <p className="text-sm pt-0.5">
            Open the app (or web/desktop) and connect to your daemon
          </p>
        </Step>
        <Step number={3}>
          <p className="text-sm pt-0.5">
            Start managing your agents from anywhere
          </p>
        </Step>
      </div>
      <p className="text-sm text-white/70 pt-2">
        Free and open source. Works on iOS, Android, web, and desktop.
      </p>
    </div>
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
  return (
    <div className="bg-card border border-border rounded-lg p-3 md:p-4 font-mono text-sm flex items-center justify-between gap-2">
      <div>
        <span className="text-muted-foreground select-none">$ </span>
        <span className="text-foreground">{children}</span>
      </div>
    </div>
  )
}

function FAQ() {
  return (
    <div className="pt-12 space-y-6">
      <h2 className="text-2xl font-medium font-serif">FAQ</h2>
      <div className="space-y-6">
        <FAQItem question="Is this free?">
          Paseo is free and open source. It wraps CLI tools like Claude Code and
          Codex, which you'll need to have installed and configured with your
          own credentials. Voice features currently require an OpenAI API key,
          but local voice is coming soon.
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
        <FAQItem question="What's the business model?">
          There isn't one. The app and server are free and open source, and
          that's not changing. I built this for myself. If I find a way to
          sustain it that benefits everyone, I'll consider it.
        </FAQItem>
        <FAQItem question="Why did you build this?">
          <p>
            I've been using Claude Code since launch. Early on I started SSHing
            into Tmux from Termux on Android so I could check on agents during
            my long walks. It worked, but the UX was rough. Dictation was bad,
            the keyboard was awkward, and the{' '}
            <a
              href="https://github.com/anthropics/claude-code/issues/826"
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="underline hover:text-white/80"
            >
              infamous scroll bug
            </a>{' '}
            meant starting over constantly.
          </p>
          <p>
            Anthropic and OpenAI added coding agents to their mobile apps, but
            they force you into cloud sandboxes where you lose your whole setup.
            Other apps exist but I wasn't happy with their UX, security, or
            business model.
          </p>
          <p>
            So I built my own. It became good enough that it felt obvious it
            should exist for others too.
          </p>
        </FAQItem>
        <FAQItem question="Isn't this just more screen time?">
          I won't pretend this can't be misused. But for me it means less time
          at my desk, not more. I brainstorm whole features with voice. I kick
          off work at my desk, then check in from my phone during a walk. I see
          what an agent needs, send a voice reply, and put my phone away.
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

function Footer() {
  return (
    <footer className="mt-24 text-sm text-muted-foreground">
      <div>
        <a href="/docs" className="hover:text-foreground transition-colors">
          docs
        </a>
        <span className="mx-2">·</span>
        <a
          href="https://github.com/moboudra/paseo"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-foreground transition-colors"
        >
          github
        </a>
      </div>
    </footer>
  )
}
