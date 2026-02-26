import { Provider as JotaiProvider } from "jotai"
import { Toaster } from "sonner"
import { appStore } from "@/lib/jotai-store"
import { AppLayout } from "@/features/layout/app-layout"

export function App() {
  return (
    <JotaiProvider store={appStore}>
      <div className="h-screen w-screen overflow-hidden bg-background text-foreground" data-agents-page>
        <AppLayout />
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
  )
}
