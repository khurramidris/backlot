import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { Logo } from "@/components/brand/Logo";
import { SiteFooter } from "@/components/layout/SiteFooter";

import { LEGAL } from "@/lib/legal";

export function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="theme-ivory min-h-screen">
      <header className="border-b border-border">
        <div className="mx-auto flex h-16 max-w-3xl items-center justify-between px-6">
          <Link to="/" className="text-xl" aria-label="Backlot home">
            <Logo />
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
        <h1 className="text-4xl">{title}</h1>
        <span className="brand-dash mt-4" />
        <p className="mt-2 text-sm text-muted-foreground">Last updated {LEGAL.updated}</p>
        <div className="legal mt-8 space-y-4 text-[15px] leading-relaxed text-foreground/90 [&_h2]:mt-10 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-foreground [&_li]:ml-5 [&_li]:list-disc [&_ul]:space-y-1">
          {children}
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
