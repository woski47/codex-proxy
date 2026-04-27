# Repository Guidelines

## Project Structure & Module Organization

This is a small Bun/TypeScript proxy service. Runtime code lives in `src/`: `server.ts` defines the Hono proxy app, `auth.ts` handles Codex auth token loading and refresh, and `peek-server.ts` serves the local inspection UI and diagnostic APIs. CLI entrypoints live in `bin/`: `proxy.ts` starts the proxy and `peek.ts` starts the peek server. Tests are colocated with source as `src/*.test.ts`. Root `rollout-*.jsonl` files are captured session artifacts; treat them as generated data, not source. `node_modules/` is vendored by installation only and should not be edited.

## Build, Test, and Development Commands

- `bun install`: install dependencies from `bun.lock`.
- `bun run dev`: run `bin/proxy.ts` with Bun watch mode for local development.
- `bun run start`: start the proxy once using `CODEX_PROXY_HOST` and `CODEX_PROXY_PORT` when set.
- `bun test`: run the Bun test suite, including `src/server.test.ts`.
- `bun run bin/peek.ts`: start the diagnostic peek server, defaulting to `127.0.0.1:8091`.

There is no separate build step or package script for linting in the current project.

## Coding Style & Naming Conventions

Use TypeScript ESM with explicit imports and two-space indentation. Prefer `const` over `let` unless reassignment is required. Keep semicolons and double quotes, matching existing files. Use `camelCase` for functions and local variables, `PascalCase` for interfaces and types, and uppercase `const` names for environment-backed configuration such as `REQUEST_TIMEOUT_MS`.

## Testing Guidelines

Use Bun's built-in test framework from `bun:test`. Add tests next to the code they cover using the `*.test.ts` suffix. Favor focused unit tests around exported helpers and stream/logging behavior before adding broader integration coverage. When tests create temporary files, isolate them under `tmpdir()` and clean them in `afterAll`, as `src/server.test.ts` does.

## Commit & Pull Request Guidelines

This checkout does not include Git metadata, so no project-specific commit convention is visible. Use short, imperative commit subjects such as `Add request log filtering` or `Fix auth refresh fallback`. Pull requests should describe the behavior change, list test commands run, mention new or changed environment variables, and include screenshots only for peek UI changes.

## Security & Configuration Tips

Do not commit local auth files, tokens, or raw diagnostic logs. Key configuration is environment-driven: `CODEX_PROXY_AUTH_FILE`, `CODEX_PROXY_UPSTREAM_ORIGIN`, `CODEX_PROXY_RAW_EVENT_LOG_FILE`, `CODEX_PROXY_REQUEST_LOG_FILE`, and related `CODEX_PROXY_*` flags. Keep defaults local-first and document any new environment variable in this guide or the PR.
