import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import heroImage from "@/assets/hero-stage.jpg";
import { Logo, StoryLine } from "@/components/brand/Logo";

/** Sign-in, sign-up and password reset: a backlot still with the tagline beside the form. */
export function AuthCard(props: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="grid min-h-screen bg-background lg:grid-cols-[1.1fr_1fr]">
      <aside className="relative hidden overflow-hidden bg-cinema lg:block">
        <img
          src={heroImage}
          alt=""
          aria-hidden
          className="absolute inset-0 size-full object-cover opacity-70"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-cinema via-cinema/40 to-cinema/70" />
        <div className="relative flex h-full flex-col justify-between p-12">
          <Link to="/" className="text-3xl text-ivory" aria-label="Backlot home">
            <Logo />
          </Link>
          <div>
            <p className="script text-6xl text-ivory">Make something worth watching.</p>
            <span className="brand-dash mt-6 w-24" />
            <StoryLine className="mt-10 block text-foreground/70" />
          </div>
        </div>
      </aside>
      <main className="flex items-center justify-center px-4 py-12 [background-image:var(--gradient-key-light)]">
        <div className="w-full max-w-sm">
          <Link to="/" className="mb-10 inline-block text-2xl lg:hidden" aria-label="Backlot home">
            <Logo />
          </Link>
          <h1 className="text-3xl">{props.title}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{props.subtitle}</p>
          {props.children}
        </div>
      </main>
    </div>
  );
}
