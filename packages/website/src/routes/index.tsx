import { createFileRoute } from '@tanstack/react-router'
import { CursorFieldProvider, FloatingButterfly } from '~/components/butterfly'
import '~/styles.css'

export const Route = createFileRoute('/')({
  head: () => ({
    meta: [
      { title: 'Paseo - Your dev environment, in your pocket' },
      {
        name: 'description',
        content:
          'Monitor and control your local AI coding agents from anywhere. Works with Claude Code and your existing setup.',
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
        <div className="absolute inset-0 bg-background/70" />
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
          <HowItWorks />
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
          href="https://github.com/anthropics/claude-code"
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
        Your dev environment,
        <br />
        in your pocket
      </h1>
      <p className="text-white/70 text-lg leading-relaxed">
        Step away from your desk. Go for a walk. The best ideas come when
        you're not staring at a screen. Now you can act on them.
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
    <div className="pt-12 space-y-6">
      <h2 className="text-2xl font-medium font-serif">What you get</h2>
      <div className="grid grid-cols-2 gap-6">
        <Feature
          title="Real-time streaming"
          description="Watch your terminal output live as agents work."
        />
        <Feature
          title="Voice commands"
          description="Talk to your agents. Dictate prompts hands-free."
        />
        <Feature
          title="Push notifications"
          description="Get notified when tasks complete."
        />
        <Feature
          title="Agent-first"
          description="Work across projects. Orchestrate multiple features at once."
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
          <p className="text-sm">Install and run the server on your machine</p>
          <CodeBlock>npm install -g @paseohq/server && paseo</CodeBlock>
        </Step>
        <Step number={2}>
          <p className="text-sm pt-0.5">
            Open the app on your phone and connect to your local server
          </p>
        </Step>
        <Step number={3}>
          <p className="text-sm pt-0.5">
            Start managing your agents from anywhere
          </p>
        </Step>
      </div>
      <p className="text-sm text-white/70 pt-2">
        Free and open source. Works on iOS, Android, and web.
      </p>
    </div>
  )
}

function HowItWorks() {
  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-medium font-serif">
        Not another cloud sandbox
      </h2>
      <p className="text-white/60 leading-relaxed">
        Paseo connects to your actual development environment. Leverage your
        existing setup without moving your code to the cloud.
      </p>
      <div className="grid gap-4 pt-2">
        <Differentiator
          title="Your local machine"
          description="Real files, real terminal, real tools. Not an ephemeral sandbox."
        />
        <Differentiator
          title="Your existing agents"
          description="Works with Claude Code, Codex, and OpenCode."
        />
        <Differentiator
          title="Your freedom"
          description="Go for a walk. Dictate ideas on the move. Let thoughts breathe."
        />
      </div>
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
          that's not changing. I built this for myself and I'm happy to share
          it. If an obvious opportunity comes up I'll consider it, but it's not
          the goal.
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
            Anthropic and OpenAI now have mobile apps, but they force you into
            cloud sandboxes where you lose your whole setup. Other apps exist
            but I wasn't happy with their UX, security, or business model.
          </p>
          <p>
            So I built my own. It became good enough that it felt obvious it
            should exist for others too.
          </p>
        </FAQItem>
        <FAQItem question="Isn't this just more screen time?">
          <p>
            The opposite. I built this to spend less time at my desk, not more.
            Ideas fade. By the time you're back at your desk, the spark is gone.
            And sometimes you just want to check on a running task or unblock it
            with a quick reply, without cutting your walk short.
          </p>
          <p>
            My quality of life has improved. I get more done than ever, but I'm
            also more present when I'm not working. This isn't about being
            available 24/7. It's about not being chained to a desk when
            inspiration strikes.
          </p>
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
    <div className="space-y-2">
      <p className="font-medium text-sm">{question}</p>
      <div className="text-sm text-white/60 space-y-2">{children}</div>
    </div>
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
          href="https://github.com/anthropics/claude-code"
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
