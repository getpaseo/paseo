import { useState } from "react"
import { signIn } from "@/lib/auth-client"
import { Button } from "@/components/ui/button"

export function LoginPage() {
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleGitHubSignIn() {
    setError(null)
    setLoading(true)

    try {
      const result = await signIn.social({
        provider: "github",
        callbackURL: window.location.origin,
      })
      if (result.error) {
        setError(result.error.message ?? "Sign in failed")
      }
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
            Sign in to continue
          </p>
        </div>

        <div className="space-y-4">
          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button
            className="w-full"
            disabled={loading}
            onClick={handleGitHubSignIn}
          >
            <svg
              className="mr-2 h-4 w-4"
              viewBox="0 0 16 16"
              fill="currentColor"
            >
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
            {loading ? "Signing in..." : "Continue with GitHub"}
          </Button>
        </div>
      </div>
    </div>
  )
}
