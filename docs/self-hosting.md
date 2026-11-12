# Self-hosting DSH as a systemd service

English | [中文](self-hosting.zh.md)

This page covers running a built checkout as a long-lived service on a Linux host, swapping the version it serves, and rolling back. It complements [development.md](development.md), which owns the contributor workflow, and it assumes the reader already knows how to build the repository.

## Prerequisites

- Node.js 24.9 or newer installed on the host, reachable as `node` on the service's `PATH`.
- A checkout of this repository with dependencies installed and artifacts built by `pnpm run build:artifacts`.
- A systemd unit that runs the `dsh` launcher from a path the service user owns, so the launcher can be replaced without root.

## Build from source

Build the artifacts once; later launches reuse them and never rebuild.

```sh
cd deepseek-harness
pnpm install
CI=1 DSH_GATE_CONCURRENCY=1 pnpm run build:artifacts --serial
```

A host with about 2 GiB of RAM needs `--serial` with `DSH_GATE_CONCURRENCY=1`, because the compiler steps request an 8 GiB V8 old-space limit each and overlapping them exhausts swap. Expect a cold build near eleven minutes on two vCPUs, with the host compiler as the longest step.

## Run as a systemd service

The unit's `ExecStart` must resolve the launcher through a path the service user can rewrite. A pnpm-generated global shim is one such path: it is a plain shell script whose `exec` line ends in the installed `bin.js`.

```sh
ExecStart=/home/ubuntu/.local/share/pnpm/bin/dsh web --host 127.0.0.1 --port 3080 --no-open
```

Set `Restart=always` with a short `RestartSec`. Combined with a user-owned launcher path, that pair is the whole upgrade mechanism: systemd restarts the process through whatever the path now contains.

## Swap the version the service runs

Repoint the launcher at the new build, then signal the main process so systemd respawns through it. No unit edit and no `systemctl restart` are involved, so no privileges beyond the service user are needed.

```sh
OLD=$(systemctl show dsh-web -p MainPID --value)
kill "$OLD"
```

A bare launcher that runs the checkout directly is the simplest form.

```sh
#!/bin/sh
exec /usr/bin/node /home/ubuntu/deepseek-harness/apps/cli/lib/bin.js "$@"
```

The service is down only for one `RestartSec` plus boot time, which is tens of seconds on a small host.

## Verify the running version

- Confirm the unit is active and the main PID changed: `systemctl is-active dsh-web` and `systemctl show dsh-web -p MainPID --value`.
- Confirm the process command line names the new entry point: `tr '\0' ' ' < /proc/$PID/cmdline`.
- Confirm the launcher reports the expected version: `dsh --version`.
- Confirm the web listener answers: `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3080/`.
- Confirm the composed profile kept every entry: `dsh web --dump-config`, then compare its entry count and identifiers with the previous release.

## Roll back

Restore the previous launcher and signal the main process again. Reuse the same respawn path so the rollback costs no more downtime than the upgrade.

```sh
cp -a backup/dsh-shim /home/ubuntu/.local/share/pnpm/bin/dsh
kill "$(systemctl show dsh-web -p MainPID --value)"
```

## Notes

- Back up the launcher and the DSH home directory before swapping. `~/.dsh` holds profiles, credentials, sessions, and storages, and a profile's `cordis.patch.yml` carries the operator's own plugin overrides.
- A release can change the session format. Restore the backed-up home directory as well when rolling back across such a release, because the older binary may not read sessions written since the upgrade.
- Running from a checkout makes the service depend on that directory. Removing it breaks the service until the launcher is restored.
- Compare `--dump-config` output across releases to spot entries that upstream removed or renamed, and check the composed tree rather than the profile files alone.
