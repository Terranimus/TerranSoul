# Linux CLI build for Terminal-Bench containers — measured findings

Harbor task containers are `linux/amd64`. The verified `terransoul-console`
binary is Windows-native, so the container needs a Linux build of the SAME
cargo target (never the retired Node loop, never Claude Code).

## What was measured, in order

Each attempt failed for a different, specific reason. All four were build
ENVIRONMENT gaps, not code or architecture defects — dependency resolution
itself succeeded on the first probe (`cargo metadata` OK).

| # | Blocker | Cause | Fix applied |
|---|---|---|---|
| 1 | `failed to open .cargo-lock` | cargo wrote into the read-only `/src` mount | dedicated `ts-linux-target` + `ts-linux-cargo` volumes |
| 2 | `libdbus-sys` build script panic | `dbus-1.pc` absent | `libdbus-1-dev`, `libgtk-3-dev`, `libwebkit2gtk-4.1-dev`, `pkg-config`, `libssl-dev` |
| 3 | `whisper-rs-sys` bindgen panic | no `libclang.so` | `clang`, `libclang-dev`, `LIBCLANG_PATH` |
| 4 | Tauri build script panic | `build.rs` writes into the source tree | `rsync` the tree to a writable `/build` copy |

After (4) the build compiled the full dependency graph including TerranSoul's
own crates (`terransoul-memory`, `terransoul-observability`, `terransoul-routing`,
`terransoul-resilience`, `terransoul-connectors`, `terransoul-animation`).

## Outcome: no binary yet

The build ran ~2 h and stalled — 11% CPU, zero files written in a 6-minute
window, no `release/terransoul-console`. The container was stopped and removed.
**1.6 GB / 289 `.rlib` files remain cached in the `ts-linux-target` volume**, so
a resumed build continues rather than restarting.

## The finding that matters

To build a *terminal benchmark agent*, this target drags in Tauri desktop
libraries, GTK, WebKit, a barcode-scanner plugin, notifications, Stronghold,
ONNX, Whisper speech, and pitch tracking. `--agent-task` uses none of them.
Three of the four blockers above (dbus, libclang/whisper, the Tauri build
script) come from subsystems the benchmark never touches.

That is the "heavy tauri" problem stated as measurement rather than opinion,
and it is the case for extracting the shared agent core (loop + tools +
in-process memory retrieval) out from under the Tauri crate.

## Two paths, both legitimate

**A — finish this build.** Resume with the warm cache, upload the ELF into each
task container via Harbor's `upload_file`. Uses the exact binary whose
`search_memory` tool is already proven working against Fable 5. Heavy image,
long build, no code risk.

**B — extract the core first.** A `terransoul-agent` crate holding the agentic
loop, the tool set, and `retrieve_prompt_memories`, with no desktop deps. Small
image, fast build, and it answers the standing "cli and mcp should not need the
heavy tauri" concern. It is a real refactor and MUST NOT change the retrieval
core — the (surface × mode) parity test in `rules/one-path-three-surfaces.md`
is the guard.

Recommendation: A first, so a measured TB number exists from the already-proven
binary; then B as its own chunk. Do not run a campaign on an unbuilt agent.
