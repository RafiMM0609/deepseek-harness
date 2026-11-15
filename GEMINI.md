# Rules for deepseek-harness on this Host

## CRITICAL HOST RESOURCE CONSTRAINT (2 GB RAM VPS)

This server is a small Linux VPS with only **1.9 GiB RAM** and **1.9 GiB Swap**.
The deepseek-harness monorepo is very large. Its aggregate TypeScript builds allocate multiple parallel `tsc` compiler processes with `--max-old-space-size=8192` peaking over **5.3 GiB RSS**.

### STRICTLY FORBIDDEN COMMANDS:
Under no circumstances should the agent run any of the following commands directly on this machine:
- `pnpm run build`
- `pnpm run build:check`
- `pnpm run build:artifacts`
- `pnpm run typecheck`
- `oxlint` (runs `tsgolint` which allocates >1.1GB RAM and 6.4GB mmap, crashing 2GB VPS)
- `pnpm test` (without a specific target file)
- `pnpm run test:coverage` (full suite)
- Any command running multiple test/check processes in parallel.

### ALLOWED ACTIONS:
- Run only single, targeted Vitest test files:
  `pnpm vitest run packages/<group>/<pkg>/tests/<name>.spec.ts`
- Run fast static checks that do not invoke compiler/linter subprocesses (e.g. `git diff --cached --check`)
- For build, full typecheck, and linter verification, rely strictly on GitHub Actions / CI.
