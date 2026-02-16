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
          href="https://github.com/getpaseo/paseo"
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1.5"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            fill="currentColor"
            viewBox="0 -0.5 25 25"
          >
            <path d="m12.301 0h.093c2.242 0 4.34.613 6.137 1.68l-.055-.031c1.871 1.094 3.386 2.609 4.449 4.422l.031.058c1.04 1.769 1.654 3.896 1.654 6.166 0 5.406-3.483 10-8.327 11.658l-.087.026c-.063.02-.135.031-.209.031-.162 0-.312-.054-.433-.144l.002.001c-.128-.115-.208-.281-.208-.466 0-.005 0-.01 0-.014v.001q0-.048.008-1.226t.008-2.154c.007-.075.011-.161.011-.249 0-.792-.323-1.508-.844-2.025.618-.061 1.176-.163 1.718-.305l-.076.017c.573-.16 1.073-.373 1.537-.642l-.031.017c.508-.28.938-.636 1.292-1.058l.006-.007c.372-.476.663-1.036.84-1.645l.009-.035c.209-.683.329-1.468.329-2.281 0-.045 0-.091-.001-.136v.007c0-.022.001-.047.001-.072 0-1.248-.482-2.383-1.269-3.23l.003.003c.168-.44.265-.948.265-1.479 0-.649-.145-1.263-.404-1.814l.011.026c-.115-.022-.246-.035-.381-.035-.334 0-.649.078-.929.216l.012-.005c-.568.21-1.054.448-1.512.726l.038-.022-.609.384c-.922-.264-1.981-.416-3.075-.416s-2.153.152-3.157.436l.081-.02q-.256-.176-.681-.433c-.373-.214-.814-.421-1.272-.595l-.066-.022c-.293-.154-.64-.244-1.009-.244-.124 0-.246.01-.364.03l.013-.002c-.248.524-.393 1.139-.393 1.788 0 .531.097 1.04.275 1.509l-.01-.029c-.785.844-1.266 1.979-1.266 3.227 0 .025 0 .051.001.076v-.004c-.001.039-.001.084-.001.13 0 .809.12 1.591.344 2.327l-.015-.057c.189.643.476 1.202.85 1.693l-.009-.013c.354.435.782.793 1.267 1.062l.022.011c.432.252.933.465 1.46.614l.046.011c.466.125 1.024.227 1.595.284l.046.004c-.431.428-.718 1-.784 1.638l-.001.012c-.207.101-.448.183-.699.236l-.021.004c-.256.051-.549.08-.85.08-.022 0-.044 0-.066 0h.003c-.394-.008-.756-.136-1.055-.348l.006.004c-.371-.259-.671-.595-.881-.986l-.007-.015c-.198-.336-.459-.614-.768-.827l-.009-.006c-.225-.169-.49-.301-.776-.38l-.016-.004-.32-.048c-.023-.002-.05-.003-.077-.003-.14 0-.273.028-.394.077l.007-.003q-.128.072-.08.184c.039.086.087.16.145.225l-.001-.001c.061.072.13.135.205.19l.003.002.112.08c.283.148.516.354.693.603l.004.006c.191.237.359.505.494.792l.01.024.16.368c.135.402.38.738.7.981l.005.004c.3.234.662.402 1.057.478l.016.002c.33.064.714.104 1.106.112h.007c.045.002.097.002.15.002.261 0 .517-.021.767-.062l-.027.004.368-.064q0 .609.008 1.418t.008.873v.014c0 .185-.08.351-.208.466h-.001c-.119.089-.268.143-.431.143-.075 0-.147-.011-.214-.032l.005.001c-4.929-1.689-8.409-6.283-8.409-11.69 0-2.268.612-4.393 1.681-6.219l-.032.058c1.094-1.871 2.609-3.386 4.422-4.449l.058-.031c1.739-1.034 3.835-1.645 6.073-1.645h.098-.005zm-7.64 17.666q.048-.112-.112-.192-.16-.048-.208.032-.048.112.112.192.144.096.208-.032zm.497.545q.112-.08-.032-.256-.16-.144-.256-.048-.112.08.032.256.159.157.256.047zm.48.72q.144-.112 0-.304-.128-.208-.272-.096-.144.08 0 .288t.272.112zm.672.673q.128-.128-.064-.304-.192-.192-.32-.048-.144.128.064.304.192.192.32.044zm.913.4q.048-.176-.208-.256-.24-.064-.304.112t.208.24q.24.097.304-.096zm1.009.08q0-.208-.272-.176-.256 0-.256.176 0 .208.272.176.256.001.256-.175zm.929-.16q-.032-.176-.288-.144-.256.048-.224.24t.288.128.225-.224z" />
          </svg>
          GitHub
        </a>
      </div>
    </nav>
  )
}

function Hero() {
  return (
    <div className="space-y-6">
      <h1 className="text-3xl md:text-5xl font-medium tracking-tight">
        Run Codex and Claude Code locally from your phone and desktop
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
