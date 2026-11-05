import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";

import { EngineError } from "./lib/engine";
import { routeTree } from "./routeTree.gen";

/** Retry network and server errors, not answers a retry can't change (not found, no plan, bad input). */
const retry = (failures: number, e: unknown) =>
  failures < 3 &&
  !(
    e instanceof EngineError &&
    e.status >= 400 &&
    e.status < 500 &&
    ![408, 429].includes(e.status)
  );

export const getRouter = () =>
  createRouter({
    routeTree,
    context: { queryClient: new QueryClient({ defaultOptions: { queries: { retry } } }) },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
  });

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
