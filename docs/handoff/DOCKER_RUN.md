# Task: make running Girru in Docker actually work, and keep it working

Added 14 November 2026 on the main computer, for Codex. Report back in the
"Result" section at the end of this file.

- **Branch:** create `codex/docker-run` from `main`. Commit there only.
- **Do not** push to `main`, merge, tag or release.
- **Do not** change the desktop app, the installers or the release workflow. This task is only about
  running the backend in a container.

## Why

`docs/DEPLOYMENT.md` lists Docker as one of three supported ways to run Girru, "Production, CI/CD,
isolated, portable". The files are there. But **nothing checks any of it**, and reading them shows at
least one certain break, so the owner does not know whether a container has ever started.

## What is there today (checked 14 November 2026, not guessed)

| File | State |
|---|---|
| `docker-compose.yml` | One service, `backend`, port 41522, two named volumes, a health check on `/api/health`. No frontend service. `version: '3.8'` is obsolete in current Compose. |
| `Dockerfile.backend` | Multi-stage: deps → python-builder → builder → runtime. Installs `pnpm@9.15.4` and copies `pnpm-lock.yaml*`. |
| `Dockerfile.frontend` | Deliberately retired: it prints "Legacy frontend retired. Use packages/core-ui with packages/backend." and exits 1. Nothing references it. |
| `.dockerignore` | Present. |
| CI | **No workflow builds either image.** The only "docker" in `.github/workflows/` is the file name `docker-invocation.test.mjs` inside the desktop test list — a different thing. |

### The certain break

`Dockerfile.backend` is built around pnpm:

```
RUN npm install -g pnpm@9.15.4
COPY package.json pnpm-lock.yaml* ./
```

There is **no `pnpm-lock.yaml` in this repository**, and no root lockfile at all. `packages/backend`
uses `package-lock.json`. The `*` glob means the COPY silently succeeds with nothing, so `pnpm install`
resolves versions fresh at build time: the image would not match the lockfile the tests and CI use, and
a build today can differ from a build tomorrow. For a memory engine whose native dependencies
(`better-sqlite3`, `usearch`) must match the Node ABI, that is not acceptable.

## What to do, in this order

1. **Get one container to start and answer**, before changing anything else. Build
   `Dockerfile.backend`, run `docker compose up`, and report what happens — including the error if it
   does not build. That output is the most useful thing in this task; put it in the Result section
   verbatim.
2. **Make the install match the repository.** Use npm with `packages/backend/package-lock.json` (`npm
   ci`), or add a real pnpm workspace if you prefer pnpm — but then it must be the lockfile the rest of
   the repo uses, not a second source of truth. The image must install the same versions CI does.
3. **Check the native modules load in the container**: `better-sqlite3` and `usearch` both have
   prebuilt binaries per platform, and Alpine (musl) is where this usually breaks. If usearch cannot
   load, recall falls back to int8 / exact — correct but slower, and the container should say so in its
   logs rather than hide it.
4. **Decide about `Dockerfile.frontend`.** It exists only to fail. Either delete it, or make it build
   `packages/core-ui`. Ask the owner which; do not guess.
5. **One workflow job that builds the image** on pull requests, so this cannot rot again. Build only —
   do not publish anything anywhere. `tests.yml` and `security-scan.yml` now run on every pull request
   (any target branch), so a new job there is enough.
6. **Correct `docs/DEPLOYMENT.md`** to say what is actually true after the above. If Docker only runs
   the backend and not the desktop app, the document should say that plainly.

## Must not change

- **The data folder stays the owner's.** The compose file keeps `.data` and `public/storage` in named
  volumes; a container must never write the owner's memory into an image layer.
- **No port but 41522**, and not published beyond what the compose file already does. 42521/42522 are
  the desktop app's and must stay free.
- **No secret in an image or a compose file.** `JWT_SECRET` and `ENCRYPTION_KEY` come from the
  environment at run time. If a build needs one to pass, that is a bug in the build, not a reason to
  bake one in.
- **The recall index never goes to disk** (S7). A container changes nothing about that.
- Do not weaken `.dockerignore` to make a build pass — check what it excludes first.

## How to check you are done

- `docker compose up` starts, `/api/health` answers 200, and the health check turns healthy.
- The versions in the image match `packages/backend/package-lock.json`.
- `better-sqlite3` and `usearch` both load, or the log says which one did not and why.
- A pull request runs the image build and it passes.
- `docs/DEPLOYMENT.md` matches reality.

## Open questions for the owner

1. **Is Docker meant for the owner's own machine, or for a server?** The answer changes whether the
   container needs Ollama reachable (the memory helper embeds there) and whether the desktop app is
   expected to talk to it.
2. **`Dockerfile.frontend`: delete, or build `packages/core-ui`?**
3. **PostgreSQL in compose?** The backend supports it, but the memory fast path is SQLite-only and the
   owner deprioritised PostgreSQL on 13 November. Probably leave it out; confirm.

## Result

Before editing any files, both `docker build -f Dockerfile.backend .` and
`docker compose -p girru-docker-baseline up -d --build` exited 1 on
`1a718703`. No container started. Relevant lines from the original build:

```text
#31 ERROR: failed to calculate checksum of ref uu2uhrlg7bcf4flc74gon7v70::2sigszao436lirr3wauuzci29: "/python-scripts": not found
#32 ERROR: failed to calculate checksum of ref uu2uhrlg7bcf4flc74gon7v70::2sigszao436lirr3wauuzci29: "/packages/backend/requirements.txt": not found
ERROR: failed to build: failed to solve: failed to compute cache key: failed to calculate checksum of ref uu2uhrlg7bcf4flc74gon7v70::2sigszao436lirr3wauuzci29: "/python-scripts": not found
```

Compose ended with:

```text
failed to solve: failed to compute cache key: failed to calculate checksum of ref uu2uhrlg7bcf4flc74gon7v70::pm0cjrhg5ddjsb9yzo04rj0p3: "/python-scripts": not found
```

The owner requested the installed Electron app and a browser on the same Docker
workspace. Compose now packages the backend, Python tools and Core UI live build
in a single image. Node 24.21.0 on Debian uses each package's committed npm lock.
The bridge reuses Girru's per-launch authentication and private random backend
port. Only the bridge publishes a host port, on IPv4 loopback at 41522. The
original numeric volume owner and named volumes carry forward. Runtime secrets
can be supplied from the environment or generated on the data volume at startup.

On Windows, `Start-Girru-Docker.cmd` opens the installed Girru in a separate
Electron profile. Manual connection, browser access and first-owner setup are
in the [deployment guide](../DEPLOYMENT.md#docker-deployment). The native app,
installers, release workflow and deferred `Dockerfile.frontend` were left as
requested. SQLite is the tested database.

Verified locally on Linux/amd64 with Docker Desktop on Windows:

- Compose reported healthy and the host received HTTP 200 with `{"status":"ok"}`.
- All 37 direct production dependency versions matched the backend lockfile.
  Native SQLite returned 42 and usearch retrieved an inserted vector from memory.
- Installed Girru 1.4.4 and Chrome both rendered the first-run UI. A disposable
  owner created inside Girru signed in through Chrome and `/api/auth/me` returned
  the same account. Both clients used the same Docker address.
- Anonymous identity access returned 401 and a foreign Origin on health returned
  403. The service ran as UID 1001.
- After a forced container recreation, setup discovery still found the owner and
  the installed Electron app and Chrome both reopened the sign-in view.
- The Tests workflow now builds the image, waits for health, checks the live UI,
  setup discovery and native modules on pull requests without publishing an image.
  [PR #218](https://github.com/Dpro-at/Girru/pull/218) ran the
  [Docker job successfully](https://github.com/Dpro-at/Girru/actions/runs/43575402685/job/132388415919).
- The Windows launcher opened the installed Electron window with its dedicated
  Docker profile and waited for first-owner setup. The Compose project is named
  `girru-docker` so other checkouts with the same directory name stay separate.
  A separate runtime test confirmed the supplied JWT and encryption keys take
  precedence over generated values.

### Merge and verification on main

On 14 November 2026, all ten checks that ran on PR head `51ebafe0` passed.
GitHub merged [PR #218](https://github.com/Dpro-at/Girru/pull/218) into
`main` at [`1b49d41f`](https://github.com/Dpro-at/Girru/commit/1b49d41f434760c15f6fe6709fa42dc96874be3e).

- All four [Tests jobs on the merge commit](https://github.com/Dpro-at/Girru/actions/runs/43576999385)
  passed. CI built and smoke-tested the Docker image, tested desktop portability
  on Windows and macOS, and passed the type checks and application suites,
  including account tests and memory-encryption tests on SQLite and PostgreSQL.
- All six [Security Scanning jobs on the merge commit](https://github.com/Dpro-at/Girru/actions/runs/43576999360)
  passed, including CodeQL, secret detection, the three dependency audits and
  dependency graph submission. The last job runs on `main` and was skipped on the PR.
