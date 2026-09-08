import { DesktopFullscreenButton } from "@/components/desktop-fullscreen-button";

export function FeatureShell({ current, title, description, hideHeader = false, children }: {
  current: string; title: string; description: string; hideHeader?: boolean; children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-bg text-fg" data-current-route={current}>
      <main className="mx-auto w-full max-w-[1440px] p-4 sm:p-6 lg:px-10">
        {!hideHeader && <div className="mb-5 flex items-start gap-3">
          <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold">{title}</h1>
          <p className="mt-1 text-sm text-muted">{description}</p>
          </div>
          <DesktopFullscreenButton />
        </div>}
        {children}
      </main>
    </div>
  );
}
