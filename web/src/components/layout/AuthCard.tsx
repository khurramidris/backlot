import { Link } from "@tanstack/react-router";
import { Clapperboard } from "lucide-react";
import type { ReactNode } from "react";

/** The centred card used by sign-in, sign-up and password reset. */
export function AuthCard(props: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="stage-light tech-grid flex min-h-screen items-center justify-center px-4 py-12">
      <div className="panel w-full max-w-md rounded-sm border border-border-strong p-8">
        <Link to="/" className="mb-7 flex items-center gap-2.5">
          <span className="flex size-6 items-center justify-center rounded-sm bg-primary">
            <Clapperboard className="size-3.5 text-primary-foreground" />
          </span>
          <span className="font-display text-base font-bold tracking-tight">Backlot</span>
        </Link>
        <h1 className="text-2xl font-semibold">{props.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{props.subtitle}</p>
        {props.children}
      </div>
    </div>
  );
}
