import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Clapperboard, LogOut } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { engine, usd } from "@/lib/engine";
import { signOut } from "@/modules/auth/auth.service";

const navLink =
  "font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground transition-colors hover:text-primary";

export function StudioShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
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
          <nav className="flex items-center gap-5">
            <Link to="/dashboard" className={navLink} activeProps={{ className: "text-primary" }}>
              Create
            </Link>
            <Link to="/credits" className={navLink} activeProps={{ className: "text-primary" }}>
              Credits{me ? ` · ${usd(me.balance_usd)}` : ""}
            </Link>
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                await signOut();
                void navigate({ to: "/auth" });
              }}
            >
              <LogOut className="size-4" />
              <span className="hidden sm:inline">Sign out</span>
            </Button>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-10">{children}</main>
    </div>
  );
}
