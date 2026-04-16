export const dynamic = "force-dynamic";

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="text-center space-y-2">
        <h1 className="text-5xl font-bold text-foreground">404</h1>
        <p className="text-sm text-muted-foreground">Page not found</p>
      </div>
    </div>
  );
}
