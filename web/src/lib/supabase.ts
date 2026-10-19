import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

/** Local development only: the engine runs with ALLOW_DEV_TOKENS and names a user to act as. */
export let devUserId: string | null = null;

export type PublicPlan = {
  name: string;
  price_usd: number;
  credits_usd: number;
  storage_gb: number;
};
/** The plan as the engine prices it, for public pages (the landing page's pricing section). */
export let publicPlan: PublicPlan = {
  name: "Basic",
  price_usd: 20,
  credits_usd: 20,
  storage_gb: 50,
};
export function setPublicPlan(plan: PublicPlan | undefined) {
  if (plan) publicPlan = plan;
}

let settings = { url: "", anonKey: "" };

/** Called once at startup with the settings the engine serves at /app-config.json. */
export function initSupabase(url: string, anonKey: string, devUser: string | null = null) {
  devUserId = devUser;
  settings = { url: url.replace(/\/$/, ""), anonKey };
  // Local development has no Supabase: the engine names a dev user instead. The client still needs some address.
  client = createClient(url || "http://localhost:54321", anonKey || "local-development", {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
}

/**
 * Whether Google sign-in is switched on in Supabase (Authentication → Providers). Until it is, the button stays
 * hidden: clicking it would land people on Supabase's "provider is not enabled" error.
 */
export async function googleSignInEnabled(
  get: typeof fetch = fetch,
  s = settings,
): Promise<boolean> {
  if (!s.url || !s.anonKey) return false;
  try {
    const r = await get(`${s.url}/auth/v1/settings`, { headers: { apikey: s.anonKey } });
    if (!r.ok) return false;
    const j = (await r.json()) as { external?: { google?: boolean } };
    return j.external?.google === true;
  } catch {
    return false;
  }
}

/** Sign-in only: all product data comes from the engine. */
export const supabase = new Proxy({} as SupabaseClient, {
  get(_, prop) {
    if (!client) throw new Error("Supabase used before initSupabase()");
    return Reflect.get(client, prop);
  },
});
