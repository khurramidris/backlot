import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

/** Local development only: the engine runs with ALLOW_DEV_TOKENS and names a user to act as. */
export let devUserId: string | null = null;

/** Called once at startup with the settings the engine serves at /app-config.json. */
export function initSupabase(url: string, anonKey: string, devUser: string | null = null) {
  devUserId = devUser;
  client = createClient(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
}

/** Sign-in only: all product data comes from the engine. */
export const supabase = new Proxy({} as SupabaseClient, {
  get(_, prop) {
    if (!client) throw new Error("Supabase used before initSupabase()");
    return Reflect.get(client, prop);
  },
});
