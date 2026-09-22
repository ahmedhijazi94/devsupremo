# New generated stack: validation evidence

Recorded on 2026-09-22. This report distinguishes executed checks from configuration review. All generated-app work used disposable local directories and synthetic credentials/data. No production database, existing app, unrelated `packages/lut-studio`, or healthy user preview was modified by these checks.

## Baseline captured before implementation

The frozen source is commit `1311f92cf18ff95952a274b5bc2031bf5d31ca92`, copied before implementation to `/private/tmp/supremo-start-baseline/repository` (528 tracked files). Environment: macOS Darwin arm64, Node 23.11.0, npm 10.9.2. Raw environment/results/logs are in `/private/tmp/supremo-start-baseline`.

| Original check | Result | Time |
| --- | --- | --- |
| Control-plane typecheck | Passed | 5.323 s |
| Control-plane lint | Passed | 6.949 s |
| Strict security audit | Passed, zero CRITICAL/HIGH; 13 preexisting MEDIUM | 5.135 s |
| Coverage | 1,770 tests, 112 files passed | 47.181 s |
| Production Next build | Passed | 12.497 s |
| CLI typecheck | Passed | 2.141 s |
| CLI tests | 678 tests, 40 files passed | 48.081 s |

Original coverage: statements/lines 98.39%, branches 95.25%, functions 95.18%. The 85% thresholds remained enabled.

The first baseline attempt was not green: loopback-listener restrictions produced `EPERM`, the default V8 heap exhausted, and a symlinked `node_modules` crossed Turbopack's project boundary. We preserved those logs, physically copied dependencies into the snapshot, permitted owned test listeners and used an 8 GiB V8 heap. The retry passed without changing application code, tests, expectations or gates. These are test-environment repairs, not attributed product regressions.

## Final control-plane and CLI regression

The final source passed typecheck, lint, strict security audit and the production **Next.js** build. Coverage passed with **1,810 tests in 114 files**: 98.86% statements/lines, 94.80% branches and 95.32% functions; the original 85% thresholds stayed enabled. The strict audit retained the same 13 preexisting MEDIUM findings and zero CRITICAL/HIGH. The built control plane was started on an unused loopback port: `/login` returned HTTP 200 with the actual Supremo login page, and only that owned process was then stopped. This does not claim a live OAuth login.

CLI typecheck and **698 tests in 41 files** passed. The final full CLI run used two workers and took 62.43 s. An earlier heavily concurrent run hit the existing 15-second daemon-progress timeout; the unchanged case passed in isolation and both subsequent full two-worker runs passed. No timeout, assertion or retry policy was weakened. The rebuilt CLI **1.8.0** was installed and executed from its digest-addressed HTTP tarball with the npm registry deliberately unreachable. The generated validator manifest consistency check and final Gitleaks history/distributed-bundle check also passed.

Full-repository lint/build/coverage ran from a physical isolated source copy because the unrelated, initially untracked `packages/lut-studio/` contains generated files that make an unrestricted workspace lint fail. That directory was neither modified nor included; no lint config or ignore rule was changed to accommodate it. Typecheck additionally passed in the working repository. Sanitized final receipt: [control-plane.json](validation/tanstack-start-5.0.0/control-plane.json).

Each clean Start profile (`public`, `solo`, `team`) passed installation, deterministic route generation, typecheck, lint, strict audit, coverage and production build. Unit counts were respectively **36, 52 and 56**, with branch coverage **98.33%, 96.19% and 96.33%**. The real worker rejected intentional type, test and security failures while preserving checkout/index identity and isolated generated routes: [validation-negative.json](validation/tanstack-start-5.0.0/validation-negative.json). Remote GitHub CI/CodeQL, hosted OAuth and deployment/promotion were not executed by these local checks.

## Frozen generated Next reference

The original generator produced a team app with template 4.0.9 in `/private/tmp/supremo-start-baseline/generated-next`. It was actually installed, typechecked, linted, tested, security scanned and production built.

| Phase | Time | Result |
| --- | --- | --- |
| Generate 81 files | 0.032 s | Passed |
| npm ci | 6.528 s | Passed |
| Typecheck | 2.736 s | Passed |
| Lint | 3.401 s | Passed |
| Unit tests | 4.232 s | Passed |
| Coverage | 1.712 s | Passed |
| Strict security audit | 0.336 s | Passed |
| Production build | 10.038 s | Passed |

These are one-machine, one-run observations, with an already populated npm cache; they are not universal performance claims. The independent runtime acceptance runner performs three-round browser startup/HMR/route/server-function comparisons using this reference.

## Start security audit extension

The existing AST detector now recognizes imported and aliased/namespace `createServerFn`, runtime `.validator(schema)` and `.inputValidator(schema)`, server-route handlers, and called local/imported server helpers. The Next checks remain covered by their original executable tests. Legacy generated Next audit bytes are frozen separately; only the new template uses the extended detector.

Executed negative cases include:

- Private RPC without identity, or relying on a route `beforeLoad`, is blocked.
- A guard in an unused helper or after the database operation does not authorize the endpoint.
- Destructured parameters and reads require actual runtime validation; an identity validator does not count.
- Using an input-provided owner ID as authorization is blocked.
- Exposed unscoped mutations are detected even when delegated to imported server implementations.
- Universal route/component imports cannot expose server-only modules or secrets; a legitimate RPC wrapper does not exempt additional leaking exports.
- `VITE_*` does not automatically make administrative secrets acceptable public values.
- Custom Start initialization must actually install CSRF middleware, not merely import or construct it.
- Mutating server routes require recognized origin/signature protection before the operation.
- CSRF and import-protection opt-outs are blocked.
- Indirect handler references that the detector cannot inspect fail closed with HIGH severity and an actionable inline-wrapper requirement.

Final targeted run: **56/56 tests passed**, in `src/lib/security/ast-audit.test.ts` and `src/lib/security/membership-audit.test.ts`. A generated Start team scaffold was scanned with the extended detector: zero findings. Static recognition supports the canonical template conventions; it is not a claim of complete JavaScript data-flow proof, and does not replace executable isolation tests.

## Real database and session isolation

A temporary PostgreSQL **14.17** cluster was started at loopback port 55483, under `/private/tmp/supremo-start-postgres`. The existing transactional RLS suite ran against both the frozen Next migration set and the Start migration set. Both passed, including own rows, denied other-tenant read/update/delete, anonymous denial, denied self-enrollment in another tenant, the intentionally vulnerable historical-policy negative fixture, and forward-migration repair.

Because Docker was unavailable, actual Supabase protocol services were also run as isolated native processes:

| Service | Tested version | Source |
| --- | --- | --- |
| Supabase Auth | 2.197.0 | Official `supabase/auth` release |
| PostgREST | 16.3 | Official `PostgREST/postgrest` release |
| PostgreSQL | 14.17 | Already installed local binary |

Downloaded release assets were checked against the official release digest. Auth and PostgREST used only the temporary `supremo_acceptance` database. A small loopback reverse proxy exposed their ordinary `/auth/v1` and `/rest/v1` paths so the **real Supabase SDK** could be exercised. No Auth, database, session, or RLS mocks were counted as proof.

Two synthetic users signed up through Supabase Auth. With ordinary authenticated sessions, each queried their own tenant resource and attempted read/update/delete against the other's resource. All **six cross-tenant attempts returned zero rows**, both attempts to self-enroll into the other organization failed with PostgreSQL `42501`, and both owners reread unchanged records. Test provisioning uses privileged access only to seed the isolated fixture; tested operations do not use `service_role`.

Evidence: `/private/tmp/supremo-start-baseline/native-services/isolation-evidence.json`. Secret-bearing local service configuration and session files are mode 0600 and are deliberately excluded from this report. The services are not a complete hosted Supabase deployment, and PostgreSQL 14.17 is explicitly the tested version; this does not claim hosted production deployment acceptance.

## Real generated CRUD exercise

The independent feature fixture is `scripts/fixtures/start-crud`. `scripts/test-start-crud.mts` generates a fresh solo Start app, adds the feature without rewriting auth/providers/build config, runs ordinary gates, then uses real browser sessions and the native services above. Its report records completed checks and any failure, without credentials.

An actual initial typecheck caught a routing mistake: an index route has typed navigation target `/notes`, while its file-route declaration remains `/notes/`. The fixture's detail links/navigation were corrected to `/notes`; no type suppression or gate bypass was introduced. Adding the feature without its tests then correctly failed coverage at 78.6%; tests were added for identity, runtime validation, ownership filters and failure behavior rather than relaxing the gate.

The real browser signup exposed another concrete integration issue: the original CSP only allowed hosted `*.supabase.co`, blocking the explicitly configured local backend (and custom backend domains). The template now permits the exact validated configured Supabase origin, with tests rejecting unsafe origins. The acceptance runner does not disable browser CSP. After the change, two real browser signups and authenticated SSR passed. A test-runner timing race was corrected to wait for filtered loader data to render before asserting the removed item. The first HTTP replay test omitted Secure cookies because the API test client treated loopback HTTP differently from Chromium; it returned 401 and was **not accepted as proof of cross-user mutation denial**. The runner now sends only the actor context's own cookie jar, requires a resource-denial response after authentication, and includes that actor's own create/read/update/delete positive controls through the identical transport. Anonymous 401 remains a separate test. Final browser acceptance **passed**; durable sanitized evidence is [crud.json](validation/tanstack-start-5.0.0/crud.json).

### Final CRUD execution

Two users signed up through the actual rendered login form against Supabase Auth. Production SSR recognized each user. The first user created two notes, filtered one out, opened a typed detail route, edited it and deleted both. The second user successfully created/read/updated/deleted its own note using the **same HTTP replay transport** used for negative probes, then was denied reading/updating/deleting the first user's ID. The attempted foreign edit carried a different title; the owner reread its unchanged resource afterward.

The cross-user RPC responses carry the validated application error `Nota não encontrada` inside HTTP 200, as the Start RPC transport serializes thrown application errors. The test therefore checks the actual error and positive authenticated controls, rather than treating a status alone as denial. Anonymous mutation separately returned **401**, cross-origin mutation **403**, and malformed input returned a serialized **Zod validation error**. The foreign detail page serialized no private title. Final ordinary-session queries found zero notes for both test accounts, then only those two synthetic accounts were removed via the administrative cleanup channel.

The generated feature passed typecheck, lint, strict audit, production build and **67 unit tests**; coverage was **100% lines/statements/functions and 96.89% branches**, with unchanged thresholds. Unit mocks exercise failure branches; only the separately executed real Auth/PostgREST/browser calls above are counted as data-isolation proof. The final sample took 4.259 s for install, 3.323 s typecheck, 3.606 s lint, 0.530 s audit, 6.046 s coverage, and 6.237 s production build. These are separate commands, not a claimed full-pipeline wall-clock duration.

Local raw evidence: `/var/folders/28/h87_3k2x261g85nt4y7j9cjr0000gn/T/supremo-start-crud-FPJV2n/evidence.json`. Durable sanitized isolation proof: [isolation.json](validation/tanstack-start-5.0.0/isolation.json). Expected diagnostic errors from deliberately denied/aborted requests are not reported as successful app requests.

## Dependency and acceptance boundaries

The Start template pins dependencies and a lockfile. In particular, Nitro **3.0.260903-beta is prerelease**; this is a deliberate tested dependency of the generated production server, not an unmentioned stable release. The control plane remains Next.

The final template lockfile passed `npm audit --audit-level=high`: **zero HIGH/CRITICAL**, with **three MODERATE** findings in development tooling (`vitest`, `@vitest/mocker`, `@vitest/coverage-v8`) associated with [GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9). This is not a claim of zero vulnerabilities. No dependency override, threshold reduction or new audit exception was used.

Gitleaks **8.21.2**, verified against its official release checksum, passed the repository's history scan (224 commits), distributed CLI scan and scan of 110 new/changed source files. A separate full-source snapshot scan found only the unchanged preexisting synthetic private-key fixture in `src/lib/checkpoint/feedback.test.ts:95`; its test body is literally `private`. No allowlist was changed. Sanitized results: [release-security.json](validation/tanstack-start-5.0.0/release-security.json).

A preview rendering successfully is not an integration/test approval. These checks do not bypass the existing checkpoint revision matching, background gates, retry limits, protected-policy hashes, or production promotion. Live OAuth providers, remote Vercel deployment and production Supabase promotion require their corresponding environments; no such results are implied by local acceptance.

## Production runtime and persistent preview

The repeatable runner is `scripts/test-start-runtime.mts`. It generates and installs a fresh Start scaffold, builds the actual Nitro production output, starts the documented production command, and drives installed Chromium. Only explicitly allowed environment variables and synthetic public/private canaries are supplied to the child processes. The optional `NEXT_RUNTIME_REFERENCE` accepts an installed disposable reference for the same three-round browser exercise.

The complete comparative run passed on **Node 22.22.1**, macOS arm64. Evidence: `/var/folders/28/h87_3k2x261g85nt4y7j9cjr0000gn/T/supremo-start-runtime-6S4Xnh/evidence.json` and its adjacent command logs.

Executed Start checks:

- Server-rendered page content is present in the original HTTP response, with nonce CSP; Chromium hydration and a real validated greeting RPC work without script/CSP errors.
- Cross-origin POST to the actual generated RPC endpoint receives **403**. Calling the real private profile RPC without an authenticated session receives **401**.
- Invalid greeting input is rejected by the server. TanStack encodes that validation error inside its RPC transport with HTTP 200; the test inspects the serialized error and verifies that no successful greeting is returned, rather than confusing transport status with RPC success.
- Four private canaries, including `VITE_SUPABASE_SERVICE_ROLE_KEY`, are absent from the browser assets and initial HTML. This verifies the explicit two-variable public mapping.
- A deliberate client import of a real `server-only` module fails the production compiler. The negative fixture exists only in the temporary generated project.
- Three repeated preview starts become HTTP-healthy; every second `ensure` keeps the same PID. Component edits preserve the entered draft; route creation/deletion, changed server-function responses, and a new browser connection all work without restarting that preview process.

| Measurement | Start + Vite | Frozen Next reference |
| --- | ---: | ---: |
| Preview startup, three-run median | 1.311 s | 3.110 s |
| Reuse healthy preview, median | 0.049 s | 0.049 s |
| Component edit visible, median | 0.180 s | 0.076 s |
| Added route visible, median | 0.294 s | 0.352 s |
| Server-function edit reflected in RPC, median | 0.127 s | 0.225 s |
| Browser readiness after navigation, including a real RPC | 1.103 s | 0.801 s |

In that Start run, clean `npm ci` took 4.163 s with populated download cache, route generation 0.432 s, typecheck 2.924 s, production build 5.053 s, and production-server HTTP readiness 0.162 s. These are individual phase timings, **not a summed claim about total verification latency**. Production build includes a fixture-only public button exercising the protected RPC; the original scaffold typecheck runs before adding that probe.

Both frameworks were measured on the same machine and Node version. Browser UI edits target imported client components (`src/features/example/greeting-form.tsx` and the equivalent temporary `app/runtime-form.tsx`), not route definition files. The first startup retains install/build caches; the second and third retain dev caches. Route/server polling adds up to 75 ms, and Playwright observation can add scheduling latency. One Start route-tree update canceled an in-flight navigation; the bounded check tolerated only that cancellation and still required the route content and subsequent 404. This run supports faster startup/server updates for this fixture, **not universal superiority**: Next's component update was faster here.

Initial diagnostic attempts are retained separately. Node 23 showed an intermittent Nitro dev-restart failure; the supported Start/tooling requirement is now Node 22.13+ on the 22 line or Node 24+. Early browser probes also attempted to edit SSR controls before development hydration had completed. The corrected test first waits for network idle and proves a working RPC, then enters its draft and measures Fast Refresh. No production plugin behavior was changed to mask those test-readiness failures. The frozen Next baseline uses its documented `localhost` origin; changing it to `127.0.0.1` would trigger its existing dev-origin protection, so that policy was preserved.

This runtime suite does not emulate or claim database isolation. The actual Auth/PostgREST/PostgreSQL proofs and the CRUD exercise are documented separately above.

The complete Start runtime suite was rerun successfully after the final configured-backend CSP fix, development preview inspector and preview error-recovery correction were included, with the regenerated validation manifests and rebuilt CLI. That fresh generation used Node 22.22.1 and passed production SSR, hydration/RPC, CSRF, anonymous denial, secret canaries, server-only compiler rejection, persistent preview and all three-round edit checks. Sanitized durable evidence: [runtime-final.json](validation/tanstack-start-5.0.0/runtime-final.json); original logs: `/var/folders/28/h87_3k2x261g85nt4y7j9cjr0000gn/T/supremo-start-runtime-0q4GGJ/evidence.json`. Its timing is not substituted into the earlier controlled comparison.

Final review caught that the new successful-page readiness check also affected tracked-process reuse: an ordinary edit returning HTTP 404/500 could incorrectly restart Vite. The Start adapter now requires HTTP 2xx/3xx when admitting a new preview, while any HTTP response proves a tracked server is still alive. Four executable HTTP regression cases prove both sides: 404/500 preserve an existing PID/token/port, and 404/500 cannot admit a new instance. All **110 harness tests passed**. The real runtime runner additionally introduces a missing import, observes HTTP 500, calls `ensure`, restores the file and observes HTTP 200 with the **same PID throughout**. The generated Next supervisor remains byte-identical to the frozen reference. This changes no test approval, scheduler or publication criterion.

## Complete generated verifier, measured end to end

`scripts/measure-generated-verifier.mts` measures the actual unchanged `npm run verify:full -- --background` command for a fresh copy of the frozen Next team scaffold and a freshly generated Start team scaffold. Both install dependencies with a populated npm download cache. Both receive the same isolated native Supabase services, ordinary generated test configuration and an identical whitespace-only source edit to select the existing browser gate. The verifier retains its original parallel checks followed by the production build; no check is skipped or reordered.

| Complete local verifier | Wall-clock time | Receipt |
| --- | ---: | --- |
| Frozen Next 4.0.9 team | 51.193 s | All seven checks passed |
| Start 5.0.0 team | 18.345 s | All seven checks passed |

The seven checks were typecheck, lint, unit/integration with coverage, real RLS/isolation, strict secret/security scan, Chromium/WebKit browser E2E, and production build. **Zero checks were deferred.** These are full-command wall-clock times, not sums of phase durations. They exclude package installation, remote CI scheduling and checkpoint transport. The runs were sequential on the same macOS machine and Node 22.22.1, with no previous build/dev cache in either fresh source workspace and with the native services already running. This is one observed full run per stack; it does not establish a universal speed ratio or production-service latency.

Sanitized durable evidence: [full-verifier.json](validation/tanstack-start-5.0.0/full-verifier.json). Original receipts and adjacent redacted logs: `/var/folders/28/h87_3k2x261g85nt4y7j9cjr0000gn/T/supremo-full-verifier-1Mc1f1/evidence.json`. The first comparison attempt reused a Next workspace containing `.supremo/preview-http/recovery.cjs` from the earlier preview benchmark, which its original lint configuration scanned and rejected. That failure was retained; it was not called a passing baseline. The final comparison used clean source copies, removing generated preview artifacts without changing Next source, lint rules or gate expectations. The executed copy omitted the nonexecutable `.supremo/DEVELOPMENT.md` guidance file; the reusable runner now preserves that documentation while continuing to exclude generated preview artifacts.

## Acceptance service cleanup

After both complete verifier runs finished, the owned temporary Auth, PostgREST, reverse proxy and PostgreSQL cluster were stopped and their process identities verified. User previews and existing database processes were not touched. Raw artifacts remain available locally; durable JSON proofs under `docs/validation/tanstack-start-5.0.0/` contain no passwords, JWTs, session cookies or privileged keys.
