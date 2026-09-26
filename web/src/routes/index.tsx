import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, Check, Clapperboard } from "lucide-react";

import heroImage from "@/assets/hero-stage.jpg";
import { usd } from "@/lib/engine";
import { publicPlan } from "@/lib/supabase";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Backlot — type a story, get a film" },
      {
        name: "description",
        content:
          "Describe a story in a sentence. Backlot writes, casts, films and edits it into a finished microdrama, short film, web series or YouTube video.",
      },
      { property: "og:title", content: "Backlot — type a story, get a film" },
      {
        property: "og:description",
        content:
          "Describe a story in a sentence. Backlot writes, casts, films and edits it into a finished microdrama, short film, web series or YouTube video.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Landing,
});

/** The four production stages, presented as a numbered pipeline rather than loose cards. */
const PIPELINE = [
  {
    index: "01",
    stage: "Write",
    title: "One sentence in",
    body: "Your idea becomes a full script with a hook, turns and an ending.",
  },
  {
    index: "02",
    stage: "Cast",
    title: "Faces that stay put",
    body: "Characters, wardrobe and sets are locked so they look the same in every shot.",
  },
  {
    index: "03",
    stage: "Approve",
    title: "See the price first",
    body: "Read the script, meet the cast, check the price. Nothing is filmed until you say go.",
  },
  {
    index: "04",
    stage: "Watch",
    title: "A finished film out",
    body: "Lip-synced dialogue, subtitles and a final edit. Fix any shot with a note.",
  },
];

function Landing() {
  return (
    <div className="tech-grid min-h-screen">
      <header className="sticky top-0 z-30 border-b border-border/70 bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <div className="flex items-center gap-2.5">
            <span className="flex size-6 items-center justify-center rounded-sm bg-primary">
              <Clapperboard className="size-3.5 text-primary-foreground" />
            </span>
            <span className="font-display text-base font-bold tracking-tight">Backlot</span>
          </div>
          <nav className="flex items-center gap-6">
            <a
              href="#pricing"
              className="text-sm font-medium text-muted-foreground transition-colors hover:text-primary"
            >
              Pricing
            </a>
            <Link
              to="/auth"
              className="text-sm font-medium text-muted-foreground transition-colors hover:text-primary"
            >
              Sign in
            </Link>
          </nav>
        </div>
      </header>

      <section className="stage-light relative overflow-hidden">
        <div className="mx-auto grid max-w-6xl items-center gap-14 px-6 py-20 lg:grid-cols-2 lg:gap-20 lg:py-28">
          <div className="space-y-8">
            <div className="inline-flex items-center gap-3">
              <span className="h-px w-8 bg-primary" />
              <span className="meta-label font-semibold text-primary">AI film production</span>
            </div>

            <h1 className="text-5xl font-bold leading-[1.06] sm:text-6xl xl:text-7xl">
              Type a story. Get a <span className="text-primary">film</span>.
            </h1>

            <p className="max-w-lg text-lg leading-relaxed text-muted-foreground">
              Microdramas, short films, web series and YouTube stories from a single prompt. Backlot
              writes, casts, films and edits it, and you approve the script and price before
              anything is rendered.
            </p>

            <div className="pt-2">
              <Link
                to="/auth"
                className="group inline-flex items-center rounded-sm bg-primary px-10 py-4 text-sm font-semibold uppercase tracking-[0.18em] text-primary-foreground shadow-[var(--shadow-glow)] transition-colors hover:bg-primary/90"
              >
                Make your first video
                <ArrowRight className="ml-3 size-4 transition-transform group-hover:translate-x-1" />
              </Link>
            </div>
          </div>

          <div className="viewfinder group relative">
            <div className="grain relative aspect-[4/3] overflow-hidden border border-border-strong bg-surface">
              <img
                src={heroImage}
                alt="Film crew on a night backlot with camera rig, monitors and warm key light"
                width={1920}
                height={1088}
                className="size-full object-cover opacity-85 grayscale transition-all duration-700 group-hover:opacity-100 group-hover:grayscale-0"
              />
              <span className="absolute right-4 top-4 z-10 bg-background/60 px-2 py-1 font-mono text-[10px] tracking-widest text-foreground/60 backdrop-blur-sm">
                CAM A // 24FPS
              </span>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-28">
        <div className="grid gap-px border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
          {PIPELINE.map((step) => (
            <div
              key={step.title}
              className="group bg-background p-8 transition-colors hover:bg-surface"
            >
              <div className="mb-8 font-mono text-[10px] tracking-[0.2em] text-primary">
                {step.index} / {step.stage.toUpperCase()}
              </div>
              <h2 className="text-lg font-bold">{step.title}</h2>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{step.body}</p>
            </div>
          ))}
        </div>
      </section>

      <Pricing />

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-8">
          <span className="meta-label">Backlot — the AI film studio</span>
          <nav className="flex gap-6">
            <Link to="/terms" className="meta-label transition-colors hover:text-primary">
              Terms
            </Link>
            <Link to="/privacy" className="meta-label transition-colors hover:text-primary">
              Privacy
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}

function Pricing() {
  const plan = publicPlan;
  return (
    <section id="pricing" className="border-t border-border">
      <div className="mx-auto grid max-w-6xl items-center gap-12 px-6 py-24 lg:grid-cols-2">
        <div>
          <div className="inline-flex items-center gap-3">
            <span className="h-px w-8 bg-primary" />
            <span className="meta-label font-semibold text-primary">Pricing</span>
          </div>
          <h2 className="mt-6 text-4xl font-bold leading-tight">One plan. Everything included.</h2>
          <p className="mt-4 max-w-md text-muted-foreground">
            Your monthly credits cover writing, casting, filming and editing. You see the price of
            every film and approve it before anything is rendered. Need more? Top up any time.
          </p>
        </div>
        <div className="border border-primary/50 bg-surface p-8 shadow-[var(--shadow-glow)]">
          <div className="meta-label text-primary">{plan.name}</div>
          <div className="mt-3 flex items-baseline gap-1">
            <span className="text-5xl font-bold">{usd(plan.price_usd)}</span>
            <span className="text-muted-foreground">/month</span>
          </div>
          <ul className="mt-6 space-y-3 text-sm">
            {[
              `${usd(plan.credits_usd)} of credits every month`,
              `${plan.storage_gb} GB of storage for your films`,
              "Top-up credit packs any time, and they never expire",
              "Failed renders refunded automatically",
              "Cancel any time",
            ].map((line) => (
              <li key={line} className="flex gap-3">
                <Check className="mt-0.5 size-4 shrink-0 text-primary" />
                {line}
              </li>
            ))}
          </ul>
          <Link
            to="/auth"
            search={{ mode: "signup" }}
            className="mt-8 inline-flex w-full items-center justify-center rounded-sm bg-primary px-6 py-3 text-sm font-semibold uppercase tracking-[0.18em] text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Get started
          </Link>
        </div>
      </div>
    </section>
  );
}
