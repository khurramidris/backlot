import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { AuthCard } from "@/components/layout/AuthCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/lib/supabase";
import { updatePassword } from "@/modules/auth/auth.service";

export const Route = createFileRoute("/reset-password")({
  head: () => ({ meta: [{ title: "Choose a new password — Backlot" }] }),
  component: ResetPassword,
});

/**
 * The link in the reset email lands here. Supabase reads the recovery token from the URL and signs the
 * user in with a PASSWORD_RECOVERY session, which is allowed to set a new password.
 */
function ResetPassword() {
  const navigate = useNavigate();
  const [ready, setReady] = useState<"waiting" | "ok" | "expired">("waiting");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY" || (event === "SIGNED_IN" && session)) setReady("ok");
    });
    // The event may already have fired before this page mounted.
    void supabase.auth.getSession().then(({ data: s }) => {
      if (s.session) setReady("ok");
    });
    const timer = setTimeout(() => setReady((r) => (r === "waiting" ? "expired" : r)), 8000);
    return () => {
      clearTimeout(timer);
      data.subscription.unsubscribe();
    };
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const r = await updatePassword(password);
    setBusy(false);
    if (r.error) return void toast.error(r.error);
    toast.success("Password changed. You're signed in.");
    void navigate({ to: "/dashboard" });
  }

  return (
    <AuthCard
      title="Choose a new password"
      subtitle={
        ready === "expired"
          ? "This reset link has expired or was already used."
          : "Pick something at least 8 characters long."
      }
    >
      {ready === "expired" ? (
        <Button asChild className="mt-6 w-full">
          <Link to="/auth" search={{ mode: "forgot" }}>
            Send a new link
          </Link>
        </Button>
      ) : (
        <form onSubmit={submit} className="mt-6 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="password">New password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={ready !== "ok"}
              required
            />
          </div>
          <Button type="submit" className="w-full" disabled={busy || ready !== "ok"}>
            {busy || ready === "waiting" ? <Loader2 className="size-4 animate-spin" /> : null}
            {ready === "waiting" ? "Checking your link…" : "Save password"}
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
