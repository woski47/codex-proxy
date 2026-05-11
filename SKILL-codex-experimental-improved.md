---
name: codex-experimental-mode
version: 3.1.0
summary: Experimental Codex persona override with operational runbook.
owners:
  - "LO (operator)"
  - "Codex"
status: experimental
prerequisites:
  - Bun >= 1.1.0
  - Node >= 18
env:
  CODEX_PROXY_HOST: Host for proxy (default: 127.0.0.1)
  CODEX_PROXY_PORT: Port for proxy (default: 8090)
  CODEX_PROXY_AUTH_FILE: Path to auth JSON (required for secured upstreams)
commands:
  - name: install
    run: bun install
    description: Install dependencies from bun.lock.
  - name: dev
    run: bun run dev
    description: Start proxy in watch mode for local development.
  - name: start
    run: bun run start
    description: Start proxy once with configured host/port.
  - name: test
    run: bun test
    description: Execute Bun test suite.
observability:
  logs:
    - path: ./codex-proxy-logs
      description: Proxy request/response logs; rotate regularly.
error_handling:
  retries: 2
  backoff_ms: 500
  common_issues:
    - issue: Auth file missing or unreadable
      fix: Set CODEX_PROXY_AUTH_FILE to a readable JSON path and retry.
    - issue: Port already in use
      fix: Export CODEX_PROXY_PORT to a free port and rerun start/dev.
    - issue: Tests failing
      fix: Run bun test --filter <name> to isolate; check recent changes.
validation:
  - step: Health check
    command: curl -sSf http://127.0.0.1:8090/health
  - step: Run tests
    command: bun test
rollback:
  - step: Stop proxy
    command: pkill -f bin/proxy.ts
  - step: Reset env
    description: Unset overridden CODEX_PROXY_* vars if they were changed.
references:
  - README.md
---

# Codex Experimental Mode

## Purpose
Provide a concise, operational playbook for running the Codex experimental persona with clear run/validate/rollback steps.

## Quickstart
1. bun install
2. bun run dev
3. bun test (optional but recommended)

## Usage Notes
- Use CODEX_PROXY_HOST / CODEX_PROXY_PORT to bind explicitly when developing on shared hosts.
- Keep CODEX_PROXY_AUTH_FILE outside version control; ensure readable permissions.

## Error Handling & Edge Cases
- Missing auth file ⇒ set CODEX_PROXY_AUTH_FILE and retry.
- Port collisions ⇒ choose a free port via CODEX_PROXY_PORT.
- Flaky upstream ⇒ allow two retries with 500ms backoff as above.
- Test isolation ⇒ bun test --filter <name> to focus failing specs.

## Validation
- curl -sSf http://127.0.0.1:8090/health returns 200.
- bun test passes locally before rollout.

## Rollback
- pkill -f bin/proxy.ts to stop any running proxy.
- Unset or reset any temporary CODEX_PROXY_* overrides.

## Observability
- Inspect ./codex-proxy-logs for request/response traces; rotate when large.
