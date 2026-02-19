import { Link, createFileRoute } from '@tanstack/react-router'
import ReactMarkdown from 'react-markdown'
import changelogMarkdown from '../../../../CHANGELOG.md?raw'
import '~/styles.css'

export const Route = createFileRoute('/changelog')({
  head: () => ({
    meta: [
      { title: 'Changelog - Paseo' },
      {
        name: 'description',
        content:
          'Product updates, fixes, and improvements shipped in each Paseo release.',
      },
    ],
  }),
  component: Changelog,
})

function Changelog() {
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-4xl mx-auto p-6 md:p-12">
        <header className="flex items-center justify-between gap-4 mb-8">
          <Link to="/" className="flex items-center gap-3">
            <img src="/logo.svg" alt="Paseo" className="w-6 h-6" />
            <span className="text-lg font-medium">Paseo</span>
          </Link>
          <div className="flex items-center gap-4">
            <Link
              to="/docs"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Docs
            </Link>
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
        </header>

        <article className="changelog-markdown rounded-xl border border-border bg-card/40 p-6 md:p-8">
          <ReactMarkdown>{changelogMarkdown}</ReactMarkdown>
        </article>
      </div>
    </div>
  )
}
