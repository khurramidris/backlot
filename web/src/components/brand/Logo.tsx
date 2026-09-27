import { cn } from "@/lib/utils";

/**
 * The Backlot B: a heavy B drawn in perspective (it leans back like a stage flat), with a Studio Orange
 * play triangle cut into it. Inherits its colour from the text colour.
 */
export function BMark({ className, title }: { className?: string; title?: string }) {
  return (
    <svg
      viewBox="0 0 100 124"
      className={cn("shrink-0", className)}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <path
        fill="currentColor"
        d="M0 0 L62 10 C86 14 98 27 98 43 C98 52 93 58 79 62 C95 66 100 76 100 88 C100 106 86 116 64 116 L0 124 Z"
      />
      <path fill="var(--color-studio)" d="M20 36 L20 88 L64 62 Z" />
    </svg>
  );
}

/**
 * The primary logo: the B mark followed by the condensed wordmark. Size it with a text size class
 * (the mark is 1.3× the cap height); colour it with a text colour class.
 */
export function Logo({ className, studio = false }: { className?: string; studio?: boolean }) {
  return (
    <span className={cn("inline-flex flex-col leading-none", className)} aria-label="Backlot">
      <span className="inline-flex items-center" aria-hidden>
        <BMark className="h-[1.3em] w-auto" />
        <span className="-ml-[0.02em] font-logo text-[1em] uppercase tracking-[-0.01em]">
          acklot
        </span>
      </span>
      {studio ? (
        <span className="mt-[0.35em] flex items-center justify-center gap-[0.4em] text-[0.28em] font-semibold tracking-[0.5em]">
          <span className="h-[2px] w-[1.6em] bg-primary" />
          STUDIO
          <span className="h-[2px] w-[1.6em] bg-primary" />
        </span>
      ) : null}
    </span>
  );
}

/** The app icon: the mark knocked out of a rounded Cinema Black square. */
export function AppIcon({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-[22%] bg-cinema text-ivory ring-1 ring-white/10",
        className,
      )}
      aria-hidden
    >
      <BMark className="h-[58%] w-auto" />
    </span>
  );
}

/** "IDEAS / SCENES / STORIES / REALITY" */
export function StoryLine({ className }: { className?: string }) {
  return (
    <span className={cn("meta-label", className)}>
      Ideas <span className="px-2 opacity-50">/</span> Scenes{" "}
      <span className="px-2 opacity-50">/</span> Stories <span className="px-2 opacity-50">/</span>{" "}
      Reality
    </span>
  );
}
