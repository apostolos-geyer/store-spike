/**
 * The SPA entry: two routes, one query client, no server rendering.
 *
 * Routes are declared in code rather than generated from the filesystem — with
 * exactly two pages, a codegen step and its watcher would be more machinery
 * than the thing it configures.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Link,
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  useRouterState,
} from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { OperatorPage } from "./routes/operator.tsx";
import { ShopPage } from "./routes/shop.tsx";
import "./styles.css";

const Shell = () => {
  const path = useRouterState({ select: (state) => state.location.pathname });
  return (
    <>
      <header className="shell">
        <span className="mark">store</span>
        <nav>
          <Link to="/operator" className={path.startsWith("/operator") ? "on" : ""}>
            Operator
          </Link>
          <Link to="/shop" className={path.startsWith("/shop") ? "on" : ""}>
            Shop
          </Link>
        </nav>
        <span className="note">one worker · three bindings · no HTTP to Commerce</span>
      </header>
      <main>
        <Outlet />
      </main>
    </>
  );
};

const rootRoute = createRootRoute({ component: Shell });

const routes = [
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: OperatorPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/operator", component: OperatorPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/shop", component: ShopPage }),
];

const router = createRouter({ routeTree: rootRoute.addChildren(routes) });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

/**
 * Nothing is cached between mounts. This is a console for poking at a live
 * deployment — a stale product list after a publish is the one thing that would
 * make it lie about what the store actually holds.
 */
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 0, retry: false, refetchOnWindowFocus: false } },
});

const mount = document.getElementById("root");
if (mount) {
  createRoot(mount).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
}
