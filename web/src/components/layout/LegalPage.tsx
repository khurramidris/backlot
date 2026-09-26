import { Link } from "@tanstack/react-router";
import { Clapperboard } from "lucide-react";
import type { ReactNode } from "react";

import { LEGAL } from "@/lib/legal";

export function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border">
        <div className="mx-auto flex h-16 max-w-3xl items-center justify-between px-6">
          <Link to="/" className="flex items-center gap-2.5">
            <span className="flex size-6 items-center justify-center rounded-sm bg-primary">
              <Clapperboard className="size-3.5 text-primary-foreground" />
            </span>
            <span className="font-display text-base font-bold tracking-tight">Backlot</span>
          </Link>
          <nav className="flex gap-5 text-sm text-muted-foreground">
            <Link
              to="/terms"
              className="hover:text-primary"
              activeProps={{ className: "text-primary" }}
            >
              Terms
            </Link>
            <Link
              to="/privacy"
              className="hover:text-primary"
              activeProps={{ className: "text-primary" }}
            >
              Privacy
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-6 py-12">
        <h1 className="text-3xl font-bold">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">Last updated {LEGAL.updated}</p>
        <div className="legal mt-8 space-y-4 text-[15px] leading-relaxed text-foreground/90 [&_h2]:mt-10 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-foreground [&_li]:ml-5 [&_li]:list-disc [&_ul]:space-y-1">
          {children}
        </div>
      </main>
    </div>
  );
}
