import { supabase } from "@/lib/supabase";

export type AuthResult = { error: string | null; needsEmailConfirmation?: boolean };

export async function signUpWithEmail(
  email: string,
  password: string,
  displayName: string,
): Promise<AuthResult> {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: `${window.location.origin}/dashboard`,
      data: { display_name: displayName },
    },
  });
  if (error) return { error: error.message };
  return { error: null, needsEmailConfirmation: data.session === null };
}

export async function signInWithEmail(email: string, password: string): Promise<AuthResult> {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  return { error: error?.message ?? null };
}

/** Returns true when the browser is being redirected to the provider. */
export async function signInWithGoogle(): Promise<{ error: string | null; redirected: boolean }> {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: `${window.location.origin}/dashboard` },
  });
  return error ? { error: error.message, redirected: false } : { error: null, redirected: true };
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
}

/** Emails a link that opens /reset-password with a recovery session. */
export async function sendPasswordReset(email: string): Promise<AuthResult> {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/reset-password`,
  });
  return { error: error?.message ?? null };
}

/** Supabase emails a confirmation link to the new address; the change applies once it's clicked. */
export async function updateEmail(email: string): Promise<AuthResult> {
  const { error } = await supabase.auth.updateUser(
    { email },
    { emailRedirectTo: `${window.location.origin}/account` },
  );
  return { error: error?.message ?? null };
}

export async function updatePassword(password: string): Promise<AuthResult> {
  const { error } = await supabase.auth.updateUser({ password });
  return { error: error?.message ?? null };
}
