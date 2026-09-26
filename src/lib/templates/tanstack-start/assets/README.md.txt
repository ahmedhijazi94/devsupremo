# __PROJECT_NAME_JS__

Supremo template `tanstack-start-vite`, version 5.1.4. Use Node 22 LTS (22.13+) or Node 24+ and `npm ci`. Copy `.env.example` to `.env.local` using only the development Supabase public URL and anon/publishable key supplied by bootstrap.

`npm run dev` starts the app at http://localhost:3000. In Supremo, use the existing preview supervisor so the process and port survive subsequent edits. Route generation happens automatically during dev and explicitly before typecheck; do not edit `src/routeTree.gen.ts`.

`npm run typecheck`, `npm run lint`, `npm test`, `npm run test:coverage`, security audit, RLS and E2E remain separate validation gates. A working preview does not imply approval.

`npm run build` produces client assets and an SSR/RPC server in `.output`. `npm start -- --port 3000` starts the production Node server. Vercel uses the `tanstack-start` preset, not a static Vite deployment. Set public Supabase variables at build time and runtime; private credentials must never use a VITE_ prefix.

The production adapter is pinned to `nitro@3.0.260903-beta`, the version used by the current official TanStack hosting integration. Its prerelease status is explicit; upgrade it only with clean install, production SSR/RPC, preview reuse and security acceptance. The lockfile pins the entire dependency graph.

The tested framework pins are TanStack Start 1.168.57, Router 1.170.38, Query 5.103.2, Vite 8.3.0, React 19.2.8, TypeScript 5.9.3, Supabase SSR 0.12.5 and Supabase JS 2.112.4. Production SSR, RPC, browser hydration and preview reuse were tested with Node 22.22.1; Node 23 is outside the supported engines. See `package.json` and `package-lock.json` for the complete exact versions.

Official implementation references: [Vite setup and route conventions](https://tanstack.com/start/latest/docs/framework/react/build-from-scratch), [Nitro and production hosting](https://tanstack.com/start/latest/docs/framework/react/guide/hosting), [server functions and runtime validation](https://tanstack.com/start/latest/docs/framework/react/guide/server-functions), [same-origin and CSRF protection](https://tanstack.com/start/latest/docs/framework/react/guide/server-functions#same-origin-requests), [server/client import protection](https://tanstack.com/start/latest/docs/framework/react/guide/import-protection). The custom Start entry explicitly installs `createCsrfMiddleware`; do not rely on default middleware after replacing that entry.

`AGENTS.md` is the concise stack guide; `.supremo/DEVELOPMENT.md` defines workflow; `SECURITY.md` defines isolation; `DESIGN.md` documents the existing design system. The template includes an SSR homepage, validated greeting RPC, typed navigation, error/loading/not-found states and, for authenticated projects, login, callback, session renewal and signout.
