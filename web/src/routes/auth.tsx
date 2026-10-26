import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";

import { AuthCard } from "@/components/layout/AuthCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { googleSignInEnabled } from "@/lib/supabase";
import {
  sendPasswordReset,
  signInWithEmail,
  signInWithGoogle,
  signUpWithEmail,
} from "@/modules/auth/auth.service";
import { useAuth } from "@/modules/auth/useAuth";

type Mode = "signin" | "signup" | "forgot";

export const Route = createFileRoute("/auth")({
  validateSearch: z.object({ mode: z.enum(["signin", "signup", "forgot"]).optional() }),
  head: () => ({
    meta: [
      { title: "Sign in — Backlot" },
      {
        name: "description",
        content: "Sign in to Backlot and turn a story into a film.",
      },
      { property: "og:title", content: "Sign in — Backlot" },
      {
        property: "og:description",
        content: "Sign in to Backlot and turn a story into a film.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const search = Route.useSearch();
  const [mode, setMode] = useState<Mode>(search.mode ?? "signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const { data: google } = useQuery({
    queryKey: ["google-sign-in"],
    queryFn: () => googleSignInEnabled(),
    staleTime: Infinity,
    retry: false,
  });

  useEffect(() => {
    if (!loading && user) void navigate({ to: "/dashboard" });
  }, [loading, user, navigate]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      if (mode === "forgot") {
        const result = await sendPasswordReset(email);
        if (result.error) {
          toast.error(result.error);
          return;
        }
        toast.success("If that email has an account, a reset link is on its way.");
        setMode("signin");
        return;
      }
      if (mode === "signup") {
        const result = await signUpWithEmail(email, password, displayName);
        if (result.error) {
          toast.error(result.error);
          return;
        }
        if (result.needsEmailConfirmation) {
          toast.success("Check your inbox to confirm your email, then sign in.");
          setMode("signin");
          return;
        }
        void navigate({ to: "/dashboard" });
      } else {
        const result = await signInWithEmail(email, password);
        if (result.error) {
          toast.error(result.error);
          return;
        }
        void navigate({ to: "/dashboard" });
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleGoogle() {
    setBusy(true);
    const result = await signInWithGoogle();
    if (result.error) {
      toast.error(result.error);
      setBusy(false);
      return;
    }
    if (result.redirected) return;
    void navigate({ to: "/dashboard" });
    setBusy(false);
  }

  const title = { signin: "Sign in", signup: "Create your account", forgot: "Reset your password" }[
    mode
  ];
  const subtitle = {
    signin: "Continue to your videos.",
    signup: "Start making films and clips.",
    forgot: "We'll email you a link to choose a new one.",
  }[mode];

  return (
    <AuthCard title={title} subtitle={subtitle}>
      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        {mode === "signup" ? (
          <div className="space-y-2">
            <Label htmlFor="displayName">Name</Label>
            <Input
              id="displayName"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Ada Lovelace"
              required
            />
          </div>
        ) : null}
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        {mode !== "forgot" ? (
          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <Label htmlFor="password">Password</Label>
              {mode === "signin" ? (
                <button
                  type="button"
                  className="text-xs text-muted-foreground underline-offset-4 hover:text-primary hover:underline"
                  onClick={() => setMode("forgot")}
                >
                  Forgot password?
                </button>
              ) : null}
            </div>
            <Input
              id="password"
              type="password"
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={8}
              required
            />
          </div>
        ) : null}
        <Button type="submit" className="w-full" disabled={busy}>
          {{ signin: "Sign in", signup: "Create account", forgot: "Send reset link" }[mode]}
        </Button>
        {mode === "signup" ? (
          <p className="text-center text-xs text-muted-foreground">
            By creating an account you agree to the{" "}
            <Link to="/terms" className="underline underline-offset-2 hover:text-primary">
              Terms
            </Link>{" "}
            and{" "}
            <Link to="/privacy" className="underline underline-offset-2 hover:text-primary">
              Privacy Policy
            </Link>
            .
          </p>
        ) : null}
      </form>

      {mode === "forgot" ? (
        <p className="mt-6 text-center text-sm text-muted-foreground">
          Remembered it?{" "}
          <button
            type="button"
            className="text-primary underline-offset-4 hover:underline"
            onClick={() => setMode("signin")}
          >
            Sign in
          </button>
        </p>
      ) : (
        <>
          {google ? (
            <>
              <div className="my-5 flex items-center gap-3 text-xs text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                or
                <span className="h-px flex-1 bg-border" />
              </div>

              <Button variant="outline" className="w-full" onClick={handleGoogle} disabled={busy}>
                Continue with Google
              </Button>
            </>
          ) : null}

          <p className="mt-6 text-center text-sm text-muted-foreground">
            {mode === "signin" ? "No account yet?" : "Already have an account?"}{" "}
            <button
              type="button"
              className="text-primary underline-offset-4 hover:underline"
              onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
            >
              {mode === "signin" ? "Create one" : "Sign in"}
            </button>
          </p>
        </>
      )}
    </AuthCard>
  );
}
