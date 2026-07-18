# Pi

This guide is for people who want to use the Pi coding agent in T3 Code. The same provider
supports both the `pi` CLI and Oh My Pi's `omp` CLI through their shared RPC transport;
OMP is not configured as a separate provider.

Pi support is **Early Access** and is disabled by default. You opt in from Settings, then
choose the installed `pi` or `omp` executable in **Binary path**.

## Before You Start

Install Pi 0.80.7 or newer, or OMP 17.0.1 or newer, and confirm it runs:

```bash
pi --version
# or
omp --version
```

Configure at least one model provider in the selected CLI, then confirm models are available:

```bash
pi --list-models
# or
omp models --json
```

If that prints models, Pi is ready.

## Enable Pi In T3 Code

Pi is off by default. Turn it on in Settings.

In Settings, your Pi provider looks like this:

```text
Display name: Pi
Binary path: pi
Require tool approval: on
```

An empty (or `pi`) `Binary path` uses the `pi` binary from your `PATH`. Enter `omp` or an
absolute OMP path to use Oh My Pi through the same provider.

## Where Pi Keeps Its Config

The selected executable owns its auth, models, and settings. Pi normally uses:

```text
~/.pi/agent/auth.json       upstream provider API keys
~/.pi/agent/models.json     enabled models
~/.pi/agent/settings.json   default provider/model, packages, theme
```

OMP normally uses `~/.omp`. T3 Code starts the selected executable as-is, so its discovered
models and credentials remain authoritative.

To point Pi at a different config directory, set `PI_CODING_AGENT_DIR` in the Pi provider's
Environment variables section in Settings. This is the Pi equivalent of a separate home,
and is useful if you want work and personal Pi setups.

## Which Models Are Available?

T3 Code discovers Pi models live. When it checks Pi's status, it briefly starts
the selected executable in `--mode rpc` and asks for its available models, then appends any
custom models you configured.

If discovery fails or times out, T3 Code falls back to your custom models only. Enable more
models with the Pi CLI (`pi config`) or by editing `~/.pi/agent/models.json`, then refresh
provider status in Settings.

## How Tool Approval Works

OMP uses its native approval tiers: `approval-required` maps to `always-ask` (read-only tools
are automatic), while `auto-accept-edits` maps to `write` (read and write tools are automatic,
execution still asks). This preserves each OMP tool's declared read, write, or execution tier.

Upstream Pi does not expose those tiers over RPC, so T3 Code adds a small compatibility
extension. In `approval-required` mode it gates every tool name because the RPC event does not
identify whether a same-named tool was provided by the runtime or overridden by an extension.
`auto-accept-edits` allows only the explicit read/edit allowlist; shell, unknown, custom, and MCP
tools still require approval. T3 Code verifies that this extension loaded and refuses to start an
ungated Pi session.

In `full-access` mode the runtime runs tools without asking. Only use it where that is
acceptable. If a gated session cannot load the approval extension, T3 Code refuses to start.

## Limitations

- **Early Access.** Expect rough edges.
- **Disabled by default.** You must enable Pi in Settings before it appears in the model
  picker.
- **Auth is inferred from model discovery.** T3 Code reports the provider as authenticated
  when the selected CLI returns available models. A disconnected local endpoint or invalid
  key can still surface when a turn starts.
- **Config belongs to the selected CLI.** Pi and OMP retain their own configuration and
  profile behavior; T3 Code does not copy credentials between them.
- **Plan mode is unavailable.** Pi and OMP RPC do not expose a plan-mode contract, so T3 Code
  hides the Plan/Build toggle for this provider.
