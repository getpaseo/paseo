import { Provider as JotaiProvider } from "jotai"
import { Toaster } from "sonner"
import { appStore } from "@/lib/jotai-store"
import { AppLayout } from "@/features/layout/app-layout"
import { LoginPage } from "@/features/auth/login-page"
import { Providers } from "@/providers"
import { useSession } from "@/lib/auth-client"

function AuthGate() {
  const { data: session, isPending } = useSession()

  if (isPending) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-background text-foreground">
        <div className="text-center text-muted-foreground">
          <div className="w-5 h-5 border-2 border-muted-foreground/30 border-t-muted-foreground rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm">Loading...</p>
        </div>
      </div>
    )
  }

  if (!session) {
    return <LoginPage />
  }

  return <AppLayout />
}

export function App() {
  return (
    <Providers>
      <JotaiProvider store={appStore}>
        <div
          className="h-screen w-screen overflow-hidden bg-background text-foreground"
          data-agents-page
        >
          <AuthGate />
          <Toaster
            position="bottom-right"
            closeButton
            richColors={false}
            toastOptions={{
              className: "text-sm",
            }}
          />
        </div>
      </JotaiProvider>
    </Providers>
  )
}
