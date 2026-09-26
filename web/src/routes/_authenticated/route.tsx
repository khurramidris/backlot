import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

import { devUserId, supabase } from "@/lib/supabase";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    if (devUserId) return; // local development against an engine with ALLOW_DEV_TOKENS
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth" });
  },
  component: () => <Outlet />,
});
