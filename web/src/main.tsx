import "./styles.css";

import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { initSupabase } from "@/lib/supabase";
import { getRouter } from "./router";

const root = createRoot(document.getElementById("root")!);

// Runtime config from the engine, so one build works in every environment.
fetch("/app-config.json")
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`app config ${r.status}`))))
  .then((cfg: { supabaseUrl: string; supabaseAnonKey: string; devUser?: string }) => {
    initSupabase(cfg.supabaseUrl, cfg.supabaseAnonKey, cfg.devUser ?? null);
    root.render(
      <StrictMode>
        <RouterProvider router={getRouter()} />
      </StrictMode>,
    );
  })
  .catch((err: unknown) => {
    console.error(err);
    root.render(
      <p style={{ padding: 24, fontFamily: "sans-serif" }}>
        Backlot is starting up. Please refresh in a moment.
      </p>,
    );
  });
