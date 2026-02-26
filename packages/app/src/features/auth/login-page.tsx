import { useState } from "react"
import { signIn, signUp } from "@/lib/auth-client"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/cn"

export function LoginPage() {
  const [mode, setMode] = useState<"login" | "signup">("login")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [name, setName] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      if (mode === "signup") {
        const result = await signUp.email({
          email,
          password,
          name: name || email.split("@")[0],
        })
        if (result.error) {
          setError(result.error.message ?? "Sign up failed")
          return
        }
      } else {
        const result = await signIn.email({ email, password })
        if (result.error) {
          setError(result.error.message ?? "Login failed")
          return
        }
      }
      // Session cookie is set — reload to pick it up
      window.location.reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : "An error occurred")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-background">
      <div className="w-full max-w-sm p-8 space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold">Junction</h1>
          <p className="text-sm text-muted-foreground">
            {mode === "login"
              ? "Sign in to your account"
              : "Create a new account"}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {mode === "signup" && (
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="name">
                Name
              </label>
              <input
                id="name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={cn(
                  "w-full px-3 py-2 text-sm border border-border rounded-md bg-background",
                  "focus:outline-none focus:ring-2 focus:ring-ring",
                )}
                placeholder="Your name"
              />
            </div>
          )}

          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={cn(
                "w-full px-3 py-2 text-sm border border-border rounded-md bg-background",
                "focus:outline-none focus:ring-2 focus:ring-ring",
              )}
              placeholder="you@example.com"
              required
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={cn(
                "w-full px-3 py-2 text-sm border border-border rounded-md bg-background",
                "focus:outline-none focus:ring-2 focus:ring-ring",
              )}
              placeholder="••••••••"
              required
              minLength={8}
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button type="submit" className="w-full" disabled={loading}>
            {loading
              ? "..."
              : mode === "login"
                ? "Sign in"
                : "Create account"}
          </Button>
        </form>

        <div className="text-center">
          <button
            type="button"
            onClick={() => {
              setMode(mode === "login" ? "signup" : "login")
              setError(null)
            }}
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            {mode === "login"
              ? "Don't have an account? Sign up"
              : "Already have an account? Sign in"}
          </button>
        </div>
      </div>
    </div>
  )
}
