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

_(Codex: fill this in. The build output from step 1 first, then what you changed, then the checks.)_
