import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Clapperboard, UserRound } from "lucide-react";
import type { ReactNode } from "react";

import { engine, usd } from "@/lib/engine";

const navLink =
  "whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground transition-colors hover:text-primary sm:tracking-[0.2em]";

export function StudioShell({ children }: { children: ReactNode }) {
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: engine.me, staleTime: 15_000 });

  return (
    <div className="tech-grid min-h-screen bg-background">
      <header className="sticky top-0 z-20 border-b border-border bg-background/85 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-6">
          <Link to="/dashboard" className="flex items-center gap-2.5">
            <span className="flex size-6 items-center justify-center rounded-sm bg-primary">
              <Clapperboard className="size-3.5 text-primary-foreground" />
            </span>
            <span className="font-display text-base font-bold tracking-tight">Backlot</span>
          </Link>
          <nav className="flex items-center gap-4 sm:gap-5">
            <Link to="/dashboard" className={navLink} activeProps={{ className: "text-primary" }}>
              Create
            </Link>
            <Link to="/billing" className={navLink} activeProps={{ className: "text-primary" }}>
              Billing{me?.credits_enforced ? ` · ${usd(me.credits.total)}` : ""}
            </Link>
            <Link
              to="/account"
              className={navLink + " flex items-center gap-1.5"}
              activeProps={{ className: "text-primary" }}
            >
              <UserRound className="size-3.5" />
              <span className="hidden sm:inline">Account</span>
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-10">{children}</main>
    </div>
  );
}
