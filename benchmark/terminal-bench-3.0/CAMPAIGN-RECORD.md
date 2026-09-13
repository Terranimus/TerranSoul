# TerminalBench

## Results

| date | benchmark | model | agent | accuracy (per-trial) | trials | tasks | status |
|---|---|---|---|---|---|---|---|
| 2026-08-12 | Terminal-Bench 2.1 | claude-sonnet-5 | terransoul (Claude Code loop) | 82.15% ± 1.14% (405/493) | 493 | 89/89 solved ≥1× | archived, private — below the 83.8% owner gate |
| — | Terminal-Bench 3.0 | claude-sonnet-5 | terransoul-cli | not yet measured | — | — | harness validated; no sweep run |

**Terminal-Bench 3.0 has no publishable number yet, and this table will not carry
one until a sweep produces it.** What exists is a validated harness: as of
2026-08-15 the agent completes trials on its own terms (`subtype: success`,
23–46 turns, files edited, memory searched and written) rather than dying on
harness defects. Every earlier trial was invalidated by a defect in the harness
or the transport and is excluded rather than averaged in — see §9.

Accuracy is **per-trial** (`successful_trials / total_trials`), which is what Harbor's
`metrics[0].mean` and the leaderboard's `compute_metrics` both compute
(`harbor/job.py:1041-1078`, `harbor/metrics/mean.py`). "89/89 tasks solved by at least
one attempt" is a different statistic and is not an accuracy. No number in this table
is estimated, projected, or carried over from a prior document.

---

## Checkpoint — 2026-08-15 20:45, teacher-student

Written at the operator's request before re-logging with a different Claude
account. Facts only; nothing here is estimated.

**The teacher credential is what changes on re-login.** `claude` authenticates
itself from `~/.claude`, so the proxy picks up the new account with no config
change — but any trial in flight at the moment of re-login will fail its next
teacher escalation. Stop the running job first.

### Where the campaign stands

Verified results, each checked against the task's own tests rather than the
analyser:

| task | model | outcome |
|---|---|---|
| memcached-backdoor | claude-sonnet-5 | **solved** — "Correctly identified backdoor (YES). PASS: Address 0x41a630 matches authfile_check start" |
| session-window-debug | claude-sonnet-5 | 3 of 7 tests passed |
| mvcc-lsm-compaction | claude-sonnet-5 | correct file and root cause, incomplete fix |

Terminal-Bench scores a task all-or-nothing, so the last two are still 0.
**No publishable accuracy exists**: the tasks run so far were chosen for
debugging, not sampled, and 4 of the 74 need a GPU this machine lacks.

### Teacher-student, as of this checkpoint

Student `gemma4:12b-it-qat` (local Ollama), teacher `claude-sonnet-5` via
`claude -p`, routed inside `packages/terransoul-claude-proxy`. Started
2026-08-15 20:39 on memcached-backdoor, mvcc-lsm-compaction and
session-window-debug — the three tasks above, so the comparison is against a
known baseline.

Escalation is triggered by an UNUSABLE reply (no content, or text naming an
offered tool with no extractable call), never by a wrong one — deciding
wrongness is the grader's job, and escalating on it would silently make this a
teacher run. `/health` reports `answered_by_student` and
`escalated_to_teacher`; **that rate must be published beside any
"TerranSoul + Gemma4" label.** At the time of writing the student had answered
every request put to it and escalated none, on 2 calls — far too few to
conclude anything.

> **RETRACTED the same night — see §10.** Those 2 calls were turn 1 of each of
> two tasks, and they were the only turns the student was ever asked. Over the
> job's full 25 assistant turns the split was **2 student / 23 teacher**, and
> the cause was a defect in this shim, not a property of gemma4. The sentence
> above is left standing because it was written in good faith from `/health` at
> a moment when the tally was genuinely 2–0, and because "far too few to
> conclude anything" was the right caveat and still did not save it.

### Resuming

    node packages/terransoul-claude-proxy/bin/terransoul-claude-proxy.mjs \
      --port 8787 --model claude-sonnet-5 --student gemma4:12b-it-qat
    bash benchmark/terminal-bench-3.0/run-terransoul.sh     # TB_TASK=... to scope
    bash benchmark/terminal-bench-3.0/watch-live.sh --tools # analyse in flight
    node packages/terransoul-cli/bin/terransoul.mjs analyze <trial-dir>

Check `/health`'s `build` against a hash of `src/*.mjs` before trusting a run —
a stale proxy passing a health check has cost this campaign a full sweep.

### Resumed — 2026-08-15 20:45, after the account change

The job the checkpoint describes as "in flight" had already finished when work
resumed, at 20:42:05, with **3 of 3 trials errored**. It is excluded from every
number here (§9).

| trial | how it died |
|---|---|
| memcached-backdoor | `Connection error.` at turn 13, after 12 real `Bash` calls |
| session-window-debug | `Connection error.` at turn 14, after 13 `Bash`/`Read` calls |
| mvcc-lsm-compaction | `docker compose build` returned **3221225794** (`0xC0000142`, DLL init failed) — the trial never ran |

The first two are the checkpoint's own predicted fallout: the operator stopped
the proxy to re-login, and the two live trials lost their endpoint mid-run.
Harbor's own `compose down` then failed with the same `0xC0000142` and left two
containers running, which were destroyed before anything else was started —
an orphan that can write into a later run's job dir is the §7g failure, and it
only has to happen once.

Two things that did hold up, both worth recording because they were claims
before they were observations:

- **§7d's per-step trajectory autosave covers the thrown-error path too**, not
  only the signal path it was written for. Both dead trials left a complete
  `trajectory.json` (24 KB and 29 KB) beside their stream log.
- **`0xC0000142` was transient and not a task defect.** Rebuilding the same
  task's environment directly took 1.9 s and exited 0, fully cached — so the
  image had built before; it was the `docker` process itself that failed to
  start. No retry knob was added for it: Harbor's `--max-retries` with
  `--retry-include RuntimeError` would also retry a `RuntimeError` raised
  *after* the agent ran (the artifact-download failure in this very job was
  one), which would hand a task a second attempt. An environment that fails to
  build is re-run as its own job instead, which is honest because the agent
  never ran.

## 10. The teacher-student arm never measured the student

The 20:39 job is the first with per-turn attribution, and reading it settles
the question the checkpoint left open. The CLI records the shim's `model` field
on every assistant event, so who answered each turn is recoverable from the
trial's own stream log — no `/health` snapshot required:

| task | student turns | teacher turns |
|---|---|---|
| memcached-backdoor | 1 (turn 1) | 11 (turns 2–12) |
| session-window-debug | 1 (turn 1) | 12 (turns 2–13) |
| **total** | **2 of 25 (8%)** | **23 of 25 (92%)** |

The shape gives it away: the student answered the first turn of each task and
never another one. That is not how a model degrades.

**Root cause, reproduced before anything was changed.** Replaying the failed
job's own messages through the production shim path, with the teacher stubbed
so no tokens were spent:

```
turn 1: student kept
turn 2: ESCALATE  student unreachable: ollama 400:
        {"error":"json: cannot unmarshal array into Go struct field
                  ChatRequest.messages.content of type string"}
turn 3: ESCALATE  (same)      turn 4: ESCALATE  (same)
```

`callStudent` forwarded `body.messages` to Ollama untouched. Ollama's
`/api/chat` requires `content` to be a **string**; the Messages API sends an
**array of blocks** from the first turn that carries tool traffic — which is
turn 2 of every real run. So the student was asked exactly once per task and
then 400'd on every subsequent turn, forever, in every task.

Three things made a broken transport read as a finding about gemma4:

1. **The renderer existed and the student did not use it.** `render.mjs`
   already flattens `tool_use`/`tool_result` blocks into text for the teacher.
   The student path had its own, absent, copy of that step. `renderContent` is
   exported now and both backends go through it, so there is one renderer
   rather than two that can drift.
2. **"Unreachable" was counted as "escalated".** Both end with the teacher
   answering, so the tally could not tell a student that needed help from a
   student that was never asked — and a rate that mixes them measures neither.
   `/health` now carries `student_unreachable` separately, and the rate that
   may be published is `escalated / (student + escalated)` with
   `student_unreachable` required to be **0** for the label to mean anything.
3. **The evidence was ephemeral.** Every one of those 23 failures WAS logged,
   once per turn, to a proxy stderr going to a terminal nobody kept. The
   durable artifact was a rate that looked like a result. The proxy's log is
   written to a file now, and the first transport failure says in the log line
   that the run is no longer measuring the student.

**Verified end to end on the real failed run's real messages**: the same replay
that escalated 4 of 5 turns now keeps 5 of 5 on memcached-backdoor and 5 of 5
on session-window-debug — 10 of 10 where it was 2 of 10. Three regression tests
were added; two fail on the pre-change `server.mjs` and the third could not
even import against the pre-change tree, which is why the replay above is
offered as its proof rather than the unit test.

This is the fourth time in this campaign that a number was produced by an
instrument rather than by the system under test (§9 lists the others). The
pattern is identical every time: a failure path that returns something
plausible instead of refusing.

### Open, and honestly unresolved

- Whether the harness gates change outcomes. Correlated once (the solved trial
  recorded lessons and had one echoed back); n=4 makes that an observation.
- `wal-recovery-ordering` fails 3 for 3 with `num_turns: 1` — its first call
  blew the old 600 s cap. The streaming idle deadline should fix it; unverified.
  Half of why it was unverified is now known: `--idle-timeout` **set nothing**.
  `serve` read the flag and handed it to `handleMessages`, whose own destructure
  did not take it, so `runClaude` always used its built-in 120 s and the knob
  was decoration. Fixed and forwarded to the retry as well, with a test that
  fails on the pre-change tree. The 120 s default was in force the whole time,
  so the deadline itself was working — only the operator's ability to move it
  was not.
- Old-CLI parity: `--ingest` needs an MCP tool first (document ingestion is
  `#[tauri::command]`-only, verified), plus `--self-improve`, `--agent-task`,
  and the generative half of `--ask`.
- `claude -p` prompt caching does NOT work here: 3 hits in 97 calls.

---

# Record

Everything below is the working record for the Terminal-Bench 3.0 campaign:
what was measured, what broke, and what is being changed. It is evidence, not
publication. The table above is the only publishable surface in this file.

## 1. Campaign target

Run Terminal-Bench 3.0 with **TerranSoul's own CLI** driving **Fable 5**, with no
Claude Code anywhere on the execution path. Credentials come from
`C:\Users\DevStar\.claude\settings.Terranimus.json` (LiteLLM proxy at
`https://api.stali.vn`, model `claude-fable-5`). The reference point on the public
TB3.0 board for the same model under a different harness is Claude Fable 5 (max) +
Claude Code at 34.1% ± 1.7 (Snorkel mirror of the TB3.0 leaderboard).

## 2. Root cause of the failed Fable 5 sweep

The sweep produced **zero artifacts** — `benchmark/terminal-bench/jobs-fable5/` is
empty, recursively, with no lock and no log. Two independent blockers were found.

### 2a. The agent loop cannot stream Fable 5 through the OpenAI-compatible path

Measured directly against the proxy, same key, same request otherwise:

| endpoint | model | `stream:true` result |
|---|---|---|
| `/v1/chat/completions` | `claude-fable-5` | **`data: [DONE]` and nothing else — zero content chunks** |
| `/v1/chat/completions` | `req/claude-fable-5` | same, zero content chunks |
| `/v1/chat/completions` | `req/claude-opus-5` | 7 chunks, content present |
| `/v1/messages` (Anthropic-native) | `claude-fable-5` | 6 events, content present |
| `/v1/chat/completions`, `stream:false` | `claude-fable-5` | full content present |

`cli.rs:1823` (`TERRANSOUL_AGENT_BASE_URL`, the TB-6 branch) deliberately forces
`--agent-task` onto `AgentTaskLlmTarget::OpenAiCompatible` so that TerranSoul owns
the tool loop rather than delegating it to a spawned `claude` binary. That decision
is correct and stays. The consequence, unnoticed until now, is that the loop reaches
Fable 5 only over `/v1/chat/completions` **streaming** — the one combination in the
table above that returns nothing.

`openai_agentic.rs:459-514` then behaves exactly as written: `text` is empty,
`extract_first_tool_call` finds no call, the `None` arm returns
`AgenticTaskOutcome { result_text: "", tool_calls: [] }`, and the process exits **0**.

That is the failure signature — every task scores 0, no tool calls, no error, exit 0.

### 2b. There is no Linux binary to put in a task container

`benchmark/terminal-bench-3.0/LINUX-BUILD-FINDINGS.md` records four build-environment
blockers cleared in order, then a ~2 h stall with no `release/terransoul-console`.
Three of the four blockers (dbus, libclang/whisper, the Tauri build script) come from
desktop subsystems `--agent-task` never touches.

## 3. A/B measurement: Claude Code CLI vs TerranSoul CLI

Same toy task ("read `words.txt`, write `words-upper.txt` uppercased, then say DONE"),
same model, same proxy, same machine.

| arm | turns | tool calls | file written | exit | input tokens | wall clock |
|---|---|---|---|---|---|---|
| `claude -p --output-format stream-json` | 6 | Glob, Read ×3, Write | yes | 0 | 152,195 (cache read 0) | 55.5 s |
| `terransoul-console --agent-task --mode max` | 1 | none | no | **0** | — | 121 s |
| `terransoul-console --agent-task --mode chat` | 1 | none | no | **0** | — | 9.6 s |
| `terransoul-console --agent-task --mode think` | 1 | none | no | **0** | — | 9.3 s |
| `terransoul -p --output-format stream-json` (Node CLI) | 3 | Read, Write | yes | 0 | 946 (cache read 2,352) | 15.5 s |

The mode is not the variable — all three Rust-CLI modes fail identically, which is
what isolated the transport rather than the reasoning rung. Claude Code succeeds
because the Anthropic SDK path it uses is `/v1/messages`, the row that streams. The
Node CLI (§7) uses that same endpoint and completes the task.

One incidental reading from the same capture, recorded because it affects cost
modelling and was not the thing being measured: the two arms' input-token totals
differ by more than two orders of magnitude on an identical task. That is a
difference in how much ambient context each CLI assembles, not a difference in the
model.

**Correction, same session.** The first version of this note also claimed prompt
caching was available on this proxy, on the strength of one Node-CLI turn reporting
`cache_read_input_tokens: 2352`. That claim does not survive checking. The
in-container trial reported 0 cached tokens against 48,632 input tokens, and a
direct probe sending an explicit `cache_control: {type: "ephemeral"}` block twice
returned identical `{"input_tokens":2309}` with **no cache fields at all** — the
proxy accepts the field and ignores it. Caching is not something this campaign can
rely on, and no cost estimate should assume it.

Reference detail from the Claude Code arm's `system:init` and `result` events, for
the parity work: it reports `claude_code_version 2.1.232`, `permissionMode`,
`apiKeySource`, a named tool list, and a result envelope carrying `num_turns`,
`duration_ms`, `duration_api_ms`, `total_cost_usd`, `usage`, `permission_denials`
and `result`. That envelope is the shape TerranSoul's CLI should emit.

## 4. Defects this exposes, independent of the benchmark

1. **An empty stream is reported as a successful no-op.** A turn that yields zero
   content chunks and no `finish_reason` is a transport failure. The loop already
   has precedent for exactly this class — the `finish_reason == "length"` branch
   immediately above (`openai_agentic.rs:466-494`) exists because treating a
   truncated fragment as "the model chose not to act" once recorded ~20 straight
   no-op iterations and was misread as a capability plateau. The empty-stream case
   has no equivalent guard.
2. **`run-fable5.sh` defaults to the production brain.** `BRAIN_PORT=7423` and
   `BRAIN_DATA=$REPO/mcp-data` unless `TB_PROXY_MODE=learn` is set
   (`run-fable5.sh:45-52`), so a re-run launched without that variable writes bench
   material into the live store.
3. **The TB3.0 adapter declares `SUPPORTS_ATIF = False` and writes no trajectory**
   (`terminal-bench-3.0/terransoul_fable5.py:26`). Harbor does not enforce the flag,
   but leaderboard static analysis fails any trial with `reward > 0` and no
   trajectory — so every *passing* trial would be rejected.
4. **`packages/bench-agent` is a second agent implementation.** A 126-line loop with
   its own hardcoded system prompt, its own tool set and no retrieval core. A number
   measured through it is not a number about TerranSoul
   (`rules/one-path-three-surfaces.md`; brain lesson #24910: "route benchmark/harness
   actors through the real product's own CLI surface, not a parallel bespoke script").

## 5. Bench-brain contamination

`mcp-data-tbench/` (2.0 GB, 1468 memories, 1785 edges) contains task-answer-derived
content from the 2.1 campaign. Memory id 1452, category `solution`, is a verified
working recipe for the `filter-js-from-html` task. 269 memories are
`self-improve-attempt` records, 59 of which cite concrete task-container paths; 12
name a 2.1 task directly, 6 of those being step-by-step recipes.

This matters beyond hygiene. The leaderboard's LLM judge lists, under
`harness_level_cheating`, "Harness gave privileged info the agent should not have
(preloaded solutions, hints, **prior-run post-mortems**, isolation failures)", and a
`harness_level_cheating` verdict renders a submission invalid. A memory store
carrying task-specific post-mortems is squarely inside that description.

Task-name overlap between the 2.1 corpus and TB3.0 is exactly one task
(`gpt2-codegolf`), so the mechanical transfer risk is small — but the categorical
risk is not about name overlap, it is about what the store is allowed to contain.
The rule the campaign runs under is unchanged and now has an external reason as well
as an internal one: **generic transferable technique may persist; task-specific
knowledge may not** (`rules/bench-agi-purity.md`).

## 6. Terminal-Bench 3.0 submission constraints (measured from Harbor 0.21.0 + leaderboard CI)

- Dataset: registry id `terminal-bench/terminal-bench`, **74 tasks**, release v3.0.0
  (2026-07-23). A submittable run must use the pinned registry dataset, never a local
  `-p` path; CI re-derives every trial and compares `config.task.ref` against the
  canonical per-task sha256 digests.
- Minimum **5 trials per task**, full task coverage → ≥ 370 trials.
- **Default execution settings only.** CI rejects any timeout multiplier, any
  `override_timeout_sec` / `max_timeout_sec`, and any cpu/gpu/memory/storage override,
  checked on the job config *and* every per-trial config.
- Errored trials count as reward 0; they are not excluded.
- Accuracy is per-trial; `pass_at_k` is per-task, any-of-k (optimistic), computed only
  when every trial has exactly one 0/1 reward key.
- ATIF trajectory (`/logs/agent/trajectory.json`, schema `ATIF-v1.7`) is required for
  every rewarded trial.
- Community submissions to the 2.1 leaderboard are closed; TB3.0 has no community
  submission CLI at all — its board is a Harbor Hub tab. A run can still be produced,
  uploaded and defended; it cannot currently be self-submitted as a PR.

## 7. Architecture decision

**CLI and MCP move to a Node project.** The desktop app, the CLI and the MCP server
are today all served from the Tauri crate — `src-tauri/Cargo.toml` documents that the
package-level `terransoul` bin is "the desktop app + MCP host" — so a container build
of the CLI drags in GTK, WebKit, dbus, whisper and ONNX that `--agent-task` never
touches. Owner directive: move the CLI and MCP out, so neither needs the 3D/voice
desktop build.

What keeps this from becoming a second implementation, which is the failure mode
`rules/one-path-three-surfaces.md` exists to prevent:

- **Retrieval stays behind MCP, and MCP is already proven to be the same core.**
  `src-tauri/src/ai_integrations/mcp/tools.rs:6072-6162` holds `BENCH-MCP-PARITY-1`,
  a test asserting the JSON-RPC `brain_search` dispatch returns *identical memory ids
  in identical order* to `commands::chat::retrieve_prompt_memories_with_options` —
  the function desktop chat and the CLI run. An out-of-process agent that recalls via
  MCP is therefore on the one path, not beside it.
- **Tool schemas are already shared rather than restated.** The MCP `brain_run_command`
  schema is *built from* `openai_agentic::run_command_tool_schema` (`tools.rs:1945-1951`)
  precisely so a hand-written second copy cannot drift.
- **The loop's own coupling to Tauri is already nil.** `openai_agentic.rs` mentions
  `tauri` twice, both in doc comments; the same is true of `openai_client.rs` and
  `agentic_cli.rs`. The `tauri` dependency in `crates/brain/Cargo.toml` is pulled in
  by unrelated siblings (`maintenance_runtime`, `submind`, `selection`, …), not by
  the agent path.

The parity guard for the port is the existing (surface × mode) table test: same mode
and same input must produce the same retrieval and reasoning on every surface.

### 7a. What was built (`packages/terransoul-cli`)

`@terransoul/cli`, bin `terransoul`. Runs on a bare Node 20 install — no Tauri, no
webview, no GTK, no ONNX, no speech stack.

- **Command surface** matches Claude Code 2.1.232 flag-for-flag where the concept
  exists: `-p/--print`, `--output-format text|json|stream-json`, `--model`,
  `--fallback-model`, `--max-turns`, `--system-prompt[-file]`,
  `--append-system-prompt[-file]`, `--add-dir`,
  `--allowedTools`/`--allowed-tools` (variadic **and** comma-separated, both
  spellings), `--disallowedTools`/`--disallowed-tools`, `--permission-mode`
  (all six advertised modes plus the unadvertised-but-accepted `default`),
  `--settings`, `--setting-sources`, `--mcp-config`, `--strict-mcp-config`,
  `--session-id`, `--verbose`, `--dangerously-skip-permissions`.
- **Config precedence** reproduces Claude Code's own array exactly:
  user → project → local → `--settings` → managed/policy. A settings `env` block
  never overwrites an already-exported variable, so a harness injecting
  credentials through the process environment always outranks a file on disk.
- **Tools** are named as Claude Code names them — Bash, Read, Write, Edit, Glob,
  Grep — so an instruction or an `--allowedTools` filter written for `claude`
  works unchanged.
- **Memory** goes through MCP and only MCP. No cache, no spool, no deferred queue.
- **`--memory-scope off|session|persistent`** makes the memory boundary an explicit
  run parameter rather than an ambient default (see §5 and §8).
- **ATIF v1.7 trajectory** via `--trajectory-path`, closing defect 3 above.
- 29 unit tests, each stating why it fails on a wrong implementation.

The A/B row above is a real run of this CLI against Fable 5, not a projection.

### 7b. Container proof

The packed CLI is **24.8 KB across 12 files**. Run in a real `linux/amd64`
`python:3.12-slim` container with no Node present:

```
[node] v20.20.2                     apt + NodeSource
[cli]  0.1.0 (TerranSoul CLI)       npm install -g the packed tarball
[exit] 0
[words-upper] ALPHA BETA GAMMA
[result] {"subtype":"success","turns":2,"tools":{"Bash":1},"ms":27484}
[atif]   ATIF-v1.7 steps 5
```

**53.6 s total, including apt, the NodeSource install and npm.** The comparison
that matters is not to another agent but to the same product's previous route
into the same container: the Tauri-linked CLI build ran ~2 h and produced no
binary at all.

One honest detail from that run: the model chose a single `Bash` one-liner
rather than `Read`+`Write`, so `edited_paths` is empty even though the file was
written. Edit tracking covers the `Write`/`Edit` tools only; a shell redirect is
invisible to it. That matters for any stop-hook that gates on "did the agent
change anything", and is recorded here rather than discovered later.

### 7c. First real Terminal-Bench 3.0 trial

Pinned registry dataset (`terminal-bench/terminal-bench`), one task, one trial,
default timeouts, `--memory-scope session`.

| | |
|---|---|
| task | `ico-path-patch` |
| trial outcome | completed, **reward 0.0**, zero exceptions |
| agent | 8 turns — `search_memory` ×1, `Bash` ×6 |
| tokens | 48,632 in / 749 out |
| trajectory | ATIF v1.7, 17 steps, written to `/logs/agent/trajectory.json` |

The pipeline is end-to-end functional: registry → task container → Node install →
CLI install → agent run → verifier → ATIF. Reward 0.0 is a real, honest failure on
a hard task, not an infrastructure error — which is exactly the distinction the
previous campaign's tooling could not make.

Four defects surfaced by this one trial, all fixed before spending on a sweep:

1. **`ca-certificates` is not a Harbor package key.** `ensure_system_dependencies`
   validates against underscored `SYSTEM_PACKAGES` keys; the correct key is
   `ca_certificates`. Install failed before a single container command ran.
2. **`shlex.quote` emits the wrong quotes for the shell Harbor uses.** `npm` is
   `npm.cmd` on Windows, so `shell=True` goes through cmd.exe, where single quotes
   are literal. `npm pack 'D:\path'` failed with a bare ENOENT.
3. **EMPTY-ANSWER-1.** The final turn's entire content was
   `[{"type":"text","text":""}]` — no tool call, no text — and the loop recorded
   `success` with an empty result. That is the empty-STREAM failure's twin one
   layer up. It now returns `error_empty_answer`. The cause was the system prompt's
   own "work by acting, not by describing", which suppressed narration across all
   8 turns and left the ATIF trajectory with no reasoning for a judge to audit;
   the prompt now asks for a one-line intent per step and a closing statement.
4. **Harbor's token counters were `None`.** The adapter never implemented
   `populate_context_post_run`, so the job could not be costed — and a
   zero-output-token run (the signature of a run that never happened) would have
   been indistinguishable from genuine failure in the mean.

### 7d. Second trial — same task, after the fixes

The prompt fix took: the model narrated on 5 of 9 turns and batched 3–4 parallel
`Bash` calls per turn instead of one. The trial then ended
`NonZeroAgentExitCodeError (exit 143)` — SIGTERM at the agent timeout — and
`/logs/agent/` contained a stream log and **no `trajectory.json`**.

That is a submission-integrity defect: a rewarded trial with no trajectory is
rejected. Two more fixes, both verified:

5. **A killed agent lost its record.** A signal handler alone is not enough —
   SIGKILL runs none, and on Windows even SIGTERM arrives as `TerminateProcess`,
   which runs none (a local probe exited 143 with no trajectory and no result
   event). The trajectory now autosaves after every step, with the signal
   handler as a second layer adding the terminal `result` event. Verified in a
   linux/amd64 container, SIGTERM mid-run: `[exit] 143`,
   `[trajectory] PRESENT`, `steps 3`, `subtype=error_interrupted`.
   That same run then exposed a self-contradicting record — `num_turns: 0`
   printed next to `tool_counts: {"Bash": 1}` — because progress published only
   at turn end; it now publishes at turn start too.
6. **The `Bash` tool timeout was 120 s.** The last entry in the killed trial's
   log was `[command timed out]`. Benchmark tasks compile, fuzz and run test
   suites; 120 s is the interactive-CLI convention, not a benchmark one. Raised
   to 600 s, with the tool description telling the model to lower it
   deliberately for commands that should be quick so a hang still surfaces.

Operational detail worth its own line, since it cost a run: TB3.0 task ids are
**registry-namespaced**. `-i ico-path-patch` matches nothing; the working form
is `-i terminal-bench/ico-path-patch`.

### 7e. Trial 4 — the harness holds

Same task, after the process-group fix. `n_errors: 0` (trials 2 and 3 both
errored), `subtype: success`, 7 turns, complete ATIF with full `final_metrics`,
and token accounting live at 49,677 in / 854 out where it had been `None`.

Reward remains 0.0. That is now an honest capability result on a stripped-binary
patching task rather than a harness death — which is the distinction the previous
campaign's tooling could not draw at all.

### 7f. Two defects found by adversarial review, not by testing

An adversarial review of `@terransoul/mcp` returned REJECT. It could not
substantiate five of the seven defect classes it was asked to hunt, and
confirmed two. Both packages' own suites were green throughout, because they
only exercised happy paths.

1. **The request deadline never covered the body read.** `fetch` resolves when
   HEADERS arrive, so clearing the timeout in a `finally` attached to it left
   `response.text()` unbounded. A brain that answered 200 and stalled mid-stream
   produced no result frame and no error frame for that id, forever — and the
   bridge then never exited, leaking the very process its own test asserts
   against. Reproduced against a stub sending `content-length: 4000` that never
   calls `res.end()`. **The identical defect was in the CLI's own MCP client**,
   written the same way the same day. On a sweep that is a *hung* trial rather
   than a failed one, which is worse: a failed trial scores 0 and moves on.
2. **The oversized-body guard killed the socket before its own 413.**
   `req.destroy()` is synchronous, so the 413 landed in a dead socket and the
   client saw `ECONNRESET`. Now `req.pause()`; re-probed with a 9 MB POST, the
   client receives the JSON-RPC error.

### 7g. A contaminated A/B, caused and then cleaned

The first A/B attempt was run in a foreground call with an inner
`timeout 2900`. The tool's own 10-minute cap fired first; **Harbor kept running
for another 40 minutes** with a live container. The retry reused the same
`-o DIR --job-name armA`, its `rm -rf` failed with "Device or resource busy",
and both runs wrote trial dirs into the SAME job dir — three trial dirs, two
from an abandoned run. Any accuracy over that dir would have averaged two runs.

Everything was destroyed and re-run with timestamped job names, so an orphan can
never write into a later run's dir. `run-terransoul.sh` already did this
(`JOB=ts-$(date ...)`); the ad-hoc command did not. Recorded as brain lesson
25964.

### 7h. Self-improve, proven rather than asserted

The lesson above was written through the real path and then recalled by
**paraphrase** — the query *"why did an abandoned benchmark job corrupt the next
run directory"* returned it at **rank 1**. The WRITE and the RECALL both
happened, which is the assertion this repo's own doctrine demands: a learning
loop needs a RECALL assertion, not a row-count assertion. Rank 2 was a related
prior lesson about racy job-directory discovery.

> **⚠️ THE MECHANISM CLAIM IS RETRACTED — 2026-08-16.** This paragraph used to
> end "That is semantic retrieval, not keyword luck." That conclusion is not
> supported and is withdrawn until it can be re-derived.
>
> The vector index was later found to be the WRONG WIDTH — 256 dimensions while
> the embedder emitted 768 — so the store refused every current-dimension vector
> at index time (`stored but NOT vector-indexed`) and the semantic half of
> retrieval contributed nothing. Hybrid retrieval degraded to keyword and kept
> answering, which is exactly why nothing noticed. Proven on 2026-08-16: a
> keyword query on an entry's literal title returned it at rank 1 while a close
> paraphrase of its own subject did not reach the top 4.
>
> The query above is not the low-overlap probe it was described as: it shares
> *job*, *run* and *directory* with the stored text, so FTS alone accounts for
> the hit. WHAT SURVIVES: the write executed and the entry was retrievable.
> WHAT DOES NOT: any claim about which retrieval channel found it. Re-derive on
> a rebuilt index with a query sharing no content words before citing this
> again.

This is the first successful persistent write since the `content`/`lesson`
argument-name defect was fixed — a path that had never once executed.

### 7i. The publish path is broken, and it is not a code defect

Checked before writing anything public, because "update the docs and the mirror"
is worthless if the mirror cannot publish.

**The mirror has failed on every run since at least 2026-08-11** — five
consecutive failures, including the push an hour ago. The cause is not the
workflow:

> The job was not started because recent account payments have failed or your
> spending limit needs to be increased.

The same GitHub Actions billing block `loop-constraints.md` already records for
CI ("Actions budget exhausted... every job died in 1-3s pre-step"). That rule
also says both per-push workflows were `gh workflow disable`d to stop the noise;
`Mirror Docs & Benchmarks` is **active** again and has been burning a failed run
on every push since. Restoring billing is a human-only action
(loop-constraints Human Gates: spending money).

Consequence for this campaign: nothing published locally reaches
`terranimus.github.io` until either billing is restored or the public repo is
updated directly from a local checkout (the workflow's own steps are just
`rsync -a --delete docs/` and `rsync -a --delete benchmark/`, so it is
reproducible by hand).

**Two latent 404s, from the 2.1 archive move.**
`docs/LLM-Brain-Design-Research-Paper/self-improvement.html` no longer exists —
the archive commit moved it to `benchmark/terminal-bench-2.1/`. The mirror uses
`--delete`, so the FIRST successful mirror run will remove the public copy, and
`docs/assets/site-nav.js` still links to it. Today the page is still live only
because no mirror run has succeeded since the move; it currently serves 2.1
claims including "Claude Sonnet 5 campaign in flight with results pending" for a
campaign that closed on 2026-08-13 at 82.15%, below the 83.8% gate.

Nothing here has been changed yet. Restoring that page is the right end-state
once a TB 3.0 number exists, and writing one before then would be inventing
data.

### 7j. Brain-server extraction, stage 1 — verified

The brain-server path is now provably Tauri-free **in place**; no file has moved.
That ordering is deliberate: the gate below is checkable in a second, where a
move is only checkable after a 20-minute build.

    grep -rn "tauri" src-tauri/src/commands/chat.rs src-tauri/src/ai_integrations/mcp/

**12 hits → 10, all prose.** Zero imports, zero types, zero attributes. An
independent verify re-ran it wider (`tauri|AppHandle|Wry|Manager|Emitter|Runtime`,
case-insensitive) and found no Tauri type in any signature, and no
`type X = tauri::…` alias cheat. Verdict: **ACCEPT, 5/5 checks pass.**

Retrieval behaviour is unchanged, proven by hunk range rather than by reading a
claim: the diff touches only lines 1–14, 3175–3237 and 3925–4051, while all
three retrieval entry points (`retrieve_prompt_memories` :808,
`…_with_options` :1233, `process_message` :2501) sit inside the untouched span
and are byte-identical to HEAD. BENCH-MCP-PARITY-1 — the guard against forking
the core — passes, inside 177 green MCP tests. Clippy exit 0.

**The four red Rust tests are now PROVEN pre-existing, not assumed.** Earlier
notes here said only that they "match the recorded known-red set". The verifier
settled it properly: the three failing asserts sit at lines 4307, 4370 and 5394,
while the last diff hunk ends at ~4051, so those test bodies and everything they
call are unchanged from HEAD. The full unfiltered suite is 3123 passed / 4
failed — exactly that set, not a superset.

**Stage 2 has one target, and the survey found it.** `AppState` holds no Tauri
types in 45 of 46 fields. The single hard coupling is
`pub harness: Mutex<Option<Arc<harness::AppHandle-owning AppHarness>>>`
(`lib.rs:666`): the `HarnessReport` trait already exists as the sink, but
`AppState` stores the CONCRETE `Arc<AppHarness>` because `app_handle()` is used
as a raw escape hatch by the MCP canvas tools. That one field is what stands
between here and a `tauri`-free core crate.

Why the code must still move: `src-tauri/Cargo.toml` carries a NON-OPTIONAL
`tauri` dependency and Cargo has no per-target dependencies
(rust-lang/cargo#1982), so a slim binary cannot live in that package however
clean its references are.

### 7k. The A/B, on the real benchmark — and what it actually says

Same pinned registry dataset, same model, same machine, k=1.

`ico-path-patch`, both arms:

| | Claude Code | TerranSoul CLI |
|---|---|---|
| turns | **101** | **7** |
| input tokens | **7,935,316** | 49,677 |
| cost | **$82.90** | ~$0.50 |
| wall clock | 1,758 s | ~173 s |
| tools | Bash ×55, **Agent ×26**, TaskCreate/Get/Update ×9, Write ×1 | Bash ×5, search_memory ×1 |
| **reward** | **0.0** | **0.0** |

Claude Code's other completed task, `cad-model`: 242 steps, 10,846,343 prompt
tokens, **$109.88**, reward 0.0.

**Both agents score zero on these tasks.** That matters before attributing
TerranSoul's zeros to TerranSoul: the first three tasks alphabetically in TB3.0
are hard, and the published Fable 5 + Claude Code figure for the whole
74-task set is 34.1%, so 0/2 on a hard subset is unremarkable for either.

Three findings that do change what to build:

1. **TerranSoul concludes after 7 turns where Claude Code works for 101.** The
   budget was not the constraint — `budget.actor.max_iterations` is 30, so the
   model chose to stop at 7. On a task this hard, stopping at 7 guarantees zero.
   More turns are plainly not sufficient (Claude Code did 101 and also scored
   zero), but 7 is too few to have a chance.
2. **Claude Code decomposes.** 26 `Agent` calls and 9 task-management calls
   against TerranSoul's flat loop. That is a capability TerranSoul does not
   have at all, not a parameter that needs tuning.
3. **A Claude Code control arm is economically impossible.** $82.90 and $109.88
   for two failed tasks. At that rate a 74-task × 5-trial control arm is roughly
   $30,000. The published leaderboard row is the only viable comparator.
   TerranSoul at ~50k tokens/task is on the order of 1/150th the cost, which is
   itself a result worth stating plainly.

Cost is inflated on both arms by the proxy's absent prompt caching
(`total_cached_tokens: 0` across 242 steps), which forces every turn to re-send
the whole growing context. On a caching endpoint both numbers would fall
sharply; neither arm gets that here, so the comparison between them is fair even
though the absolute figures are not representative.

**Claude Code's `ico-path-patch` trial wrote no `trajectory.json`** — only
`claude-code.txt` and `sessions`. That is the same submission-integrity gap
fixed in §7d for TerranSoul: a rewarded trial without a trajectory is rejected
by leaderboard static analysis. It is not unique to our harness.

## 9. Invalidated runs, and why each is excluded

`rules/bench-agi-purity.md` and the owner's standing "clean record" instruction:
a run measured through a broken instrument is not a low score, it is not a
score. Every run below is discarded, not averaged in.

| run | why it is not data |
|---|---|
| Fable 5, jobs-fable5 | never executed — Harbor created no job dir |
| trials 1–4 (Fable 5) | harness defects: empty-stream success, lost trajectory, `pkill` self-termination |
| A/B arm A first attempt | orphaned Harbor job wrote into the SAME job dir as its retry — three trial dirs, two abandoned |
| Sonnet shakedown 1–2 | transport read the request as prompt injection; repo `CLAUDE.md` leaked into the agent |
| Sonnet shakedown 3 | ran on a stale proxy that `/health` reported as healthy |
| Sonnet shakedown 4 | tool calls unparsed (three syntaxes), then the miner blocked every run from ending |
| teacher-student, ts-gemma4-20260815-203920 | 3/3 errored: two lost the proxy mid-run when it was stopped for the account change, one never built its environment (`0xC0000142`). Separately, its student was unreachable on every turn after the first (§10), so even a completed run would have measured the teacher |

The A/B against Claude Code (§7k) is retained because both arms ran through the
same instrument at the same time, so the comparison holds even though neither
arm's absolute number does.

## 8. Open items

- ~~Fix the empty-stream silent success in the agent loop~~ ✅ EMPTY-STREAM-1.
  `StreamedTurn` gained `choice_chunks`; the loop returns `Err` naming the model and
  endpoint instead of an empty success. Four regression tests, including one that
  proves an empty answer *with* a real choice chunk is still a valid turn, so the
  guard cannot be satisfied by erroring on all empty text.
- ~~Route the agent path to `/v1/messages`~~ ✅ for the Node CLI, which uses the
  Anthropic SDK. The Rust `--agent-task` path is still pinned to the
  OpenAI-compatible endpoint and now fails loudly there rather than silently.
- ~~Claude Code CLI command/config parity~~ ✅ §7a.
- ~~ATIF trajectory emission~~ ✅ `--trajectory-path`.
- Harbor adapter rewritten against the Node CLI (installs Node + the package,
  runs `terransoul -p @task --trajectory-path /logs/agent/trajectory.json`,
  flips `SUPPORTS_ATIF` to True).
- Isolated bench brain, seeded with generic technique only, wiped of task-specific rows.
- `run-fable5.sh` must not default to the production brain (defect 2).
- Retire or re-point `terransoul-console --agent-task` so there is ONE CLI, not two.
  Until then the (surface × mode) parity table has a genuine gap and this is the
  campaign's largest outstanding architectural risk, not a tidy-up.
- Correct the root-level published number: this file previously carried
  `1.0000 / 471+ trials`, which conflated the per-task solved rate with accuracy and
  used a superseded trial count. `benchmark/terminal-bench-2.1/TerminalBench.md:22-48`
  already records the correct 82.15% ± 1.14% (405/493) and states that the two must
  not be conflated. The table above now carries the archive's own figure. ✅ done

## Checkpoint — 2026-08-16 23:20, the observability tool could not read its own campaign's runs

Root-causing the most recent sweep (`jobs-learn/tslearn-20260816-193038`: claude-code
agent, claude-sonnet-5, the isolated learn-mode brain from §8, 3 debug tasks × k=2)
using `terransoul analyze`, per the CLI's own stated purpose — this campaign's
root-causing had been done "by a human hand-writing throwaway Python against trial
directories, because the product that HAS a root-cause analyzer structurally could
not point it at its own runs" (`packages/terransoul-cli/src/analyze.mjs` header).
That sentence was still true when this checkpoint started, for a second reason its
author had not yet found.

**Bug 1 — `analyze <run-dir>` crashed on the exact directory shape this campaign
produces.** The directory-resolution candidate list only knew `terransoul-stream.jsonl`
(TerranSoul's own Node CLI's output file). A Harbor trial run under the `claude-code`
agent — every trial in this sweep — has no such file; Harbor tees that agent's own
stream to `agent/claude-code.txt` instead, same event schema (TerranSoul's Node CLI
was built to match Claude Code's stream-json flag-for-flag). `analyze` on a real trial
directory threw `EISDIR` trying to `readFile` the directory itself. Fixed:
`agent/claude-code.txt` and `claude-code.txt` added as candidates in
`packages/terransoul-cli/bin/terransoul.mjs`, and a directory with NO recognisable
candidate now reports the usage-style "no stream-json found" message instead of
crashing. Two regression tests, both failing pre-change with an uncaught `EISDIR`.

**Bug 2 — once readable, the analyser's own `silent-turn` check was systematically
wrong.** Claude Code's stream-json emits ONE `assistant` event PER CONTENT BLOCK, not
one per logical turn: with extended thinking on, a real turn arrives as a
`thinking`-only event immediately followed by a separate `tool_use` event, no `user`
event between them. The check only recognised `text` and `tool_use` as non-silent
content, so it flagged EVERY bare-thinking event — on `memcached-backdoor__KzwXtNp`
alone, 90 of 191 raw assistant events (`result.num_turns` says 105; that mismatch is
itself the tell). Every one of those 90 warnings was reasoning about to act, not
silence. Fixed in `packages/terransoul-cli/src/analyze.mjs`: a `thinking` or
`redacted_thinking` block now counts as non-silent. Two regression tests: one proving
a thinking-only event is no longer flagged, one proving a genuinely empty event still
is (the fix narrows the check, it does not disable it).

Both fixes verified against the real sweep, not just the fixtures: pre-fix, `analyze`
crashed outright on all four completed trials; post-fix, each reports a clean,
readable finding set. All 214 `terransoul-cli` tests pass.

**What the now-trustworthy analysis actually shows, all four completed trials:**
`claimed-success-but-failed` (the agent declared done; the verifier scored 0) and
`success-without-changes` (no `Write`/`Edit` call). Checked `memcached-backdoor__KzwXtNp`
by hand against its own artifact rather than trusting the summary: the agent DID write
`/app/backdoor-detected.txt` — via `Bash`, which `edited_paths` does not track, the
already-documented blind spot from §7b — but the content was `NO`; the verifier's own
`test-stdout.txt` reads `FAIL: Did not correctly identify the backdoor (answered: NO)`.
That is a genuine capability miss on a hard reverse-engineering task, not a harness
defect — the same task was answered correctly in an earlier trial (§"Where the
campaign stands"), so this is real variance, not something to paper over with a
bench-only workaround.

**Two of the six trials errored with `AgentSetupTimeoutError` (360 s), both during the
`npm install -g @anthropic-ai/claude-code` step.** Grepped every job log in this
campaign for the same string: this is the ONLY job it has occurred in. A one-off,
most likely transient network/host contention, not a recurring architecture defect —
recorded here rather than chased further, per §9's own rule that a harness failure is
excluded, not scored, and does not need a root cause beyond "not the data."

**Redo blocked on a credential decision, not a code defect.** Reconstructing the
launch (this job has no committed launcher — it was run by hand, itself a gap worth
naming): the isolated bench brain (`mcp-data-tbench-clean/`, port :7424) that this job
used was stopped earlier this session after an unrelated purity check; Harbor's own
`--config <path>` flag can replay this job's exact `config.json` (agent, model,
3-task dataset, MCP wiring) verbatim, which avoids hand-retyping a launch and the
misconfiguration risk that comes with it. The one missing piece is
`CLAUDE_CODE_OAUTH_TOKEN`: this shell has no such env var, and the one credential
available is this very Claude Code session's own live OAuth token
(`~/.claude/.credentials.json`). Extracting a live session credential into a
benchmark container without being asked is exactly the kind of action that deserves
a human decision rather than a unilateral one — it would also share this session's
own rate limit with the sweep, the same collision class already recorded in the
2026-08-15 20:45 checkpoint above. Asked the operator rather than guessing,
who approved reusing the live session token.

### The redo, `tslearn-redo-20260817-000740`

Restarted the isolated learn-mode brain (`mcp-data-tbench-clean/`, :7424) and
`mcp-auth-proxy.mjs` (:7425, `TB_PROXY_MODE=learn`, `think` pinned), then
replayed the prior job's exact `config.json` via Harbor's own `--config`
flag rather than hand-retyping the invocation — same agent, same model, same
3-task dataset, same MCP wiring, `n_attempts` dropped from 2 to 1 (this
subset is a debug sample, not the submission; halving it removes any
cross-attempt-leakage question rather than requiring `TB_DEFER_WRITES`
machinery to answer it). The extra-instruction file for the vanished-original
job doesn't exist anywhere anymore, so a fresh TB3.0-appropriate one is now
committed (`benchmark/terminal-bench-3.0/extra-instruction.md`), closing the
"no committed launcher" gap this file already named.

**One false start, cleaned up rather than left.** The first launch attempt ran
harbor as a detached child of a Node wrapper script instead of via the shell
tool's own background-execution mode; the tool call's own timeout killed the
wrapper before harbor finished, and it left two orphaned `__env-main-1`
containers building/starting — the exact failure class §7g and lesson 25964
already name. Stopped and removed both, deleted the job dir it had half
written (`n_completed_trials: 0`, `finished_at: null`, no cost recorded — the
kill landed before the agent proper started, so nothing was lost), then
relaunched correctly via the tool's background-execution mode.

**Result, real and clean: 3/3 completed, 0 exceptions, 25m44s.**

| task | reward | turns | cost (own stream) |
|---|---|---|---|
| memcached-backdoor | **1.0** | 127 | $6.19 |
| mvcc-lsm-compaction | 0.0 | 26 | $0.60 |
| session-window-debug | 0.0 | 33 | $1.63 |

**Zero `AgentSetupTimeoutError` this time**, where the prior job had two —
confirms that was a one-off (transient host/network contention during the
concurrent `npm install -g claude-code` step), not a recurring defect, exactly
as the prior checkpoint's grep-across-every-job-log already concluded.

**The analyzer (both fixes) verified clean against entirely fresh data.** No
crash, no false `silent-turn` noise, on all three trials. `mvcc-lsm-compaction`
and `session-window-debug` both report `claimed-success-but-failed`: the agent
declared done, the verifier disagreed. `session-window-debug` also carries one
`grader-probe` finding — checked by hand, not just trusted: the command
(`find / -iname '*test*'`, `find / -iname '*harbor*'`, `ls /app` `ls /`) found
nothing (`/usr/bin/test`, ordinary system paths; the verifier mount was not
yet populated), ordinary exploration on a task named "session window", not a
graded-path leak. `memcached-backdoor` **passed with the correct answer this
time** (`YES`, address `0x41a630`) — the SAME task an earlier redo attempt this
session answered `NO` on. Real capability variance on a hard reverse-engineering
task, confirmed twice now in two directions; not a bug in either direction.

**One real gap, but not TerranSoul's to fix.** Every trial's own `result.json`
(`agent_result.n_input_tokens/n_output_tokens/cost_usd`) is `null`, even though
each trial's raw stream carries complete `usage`/`total_cost_usd` fields (the
table above is summed from those streams by hand). This job's prior sibling
had real numbers at the top level (`n_input_tokens: 14987028, cost_usd: 8.45`),
so something about Harbor's own post-run usage extraction didn't fire here —
that code lives in Harbor's `claude_code.py` adapter, not in anything this
repo ships, and the owner instruction is explicit that every change here must
be TerranSoul's own default behaviour, not a bench-only patch to a vendored
tool. Recorded as an open question, not chased further.

**Real total for this redo: $8.42, 3 trials.** Close to the $8.45 the prior
6-trial job cost, because this run's one passing trial did 127 real turns
solving a hard task instead of stopping early — trial count halved, but the
task that actually got solved got expensive. Scaling that per-trial rate
(~$2.80/attempt) to a submittable 74-task × 5-trial sweep is **order
$1,000+**, a real spend decision for the operator, not mine to make
unilaterally (`loop-constraints.md`, human gate: spending money).

### A bigger finding, underneath the clean numbers: this architecture has never run TerranSoul's own harness

Every trial's `analyze` summary carries `"harness":null,"memory":null` — on
BOTH sweeps, every task, no exception. Checked why directly against a raw
`claude-code.txt` result event rather than assumed: Claude Code's own native
`result` event has no `harness` or `memory` field at all. Those fields are
constructed in `packages/terransoul-cli/src/loop.mjs:384,694` — TerranSoul's
OWN agent loop's result shape, which is what carries `ReviewOnStopGate` (the
verify-before-declaring-done gate), the recall gate, and memory-scope
enforcement.

**Consequence: nothing in this campaign has ever run TerranSoul's own
self-improving harness.** Every trial measured so far is Claude Code, with
TerranSoul reachable only as an MCP memory server the model may or may not
call. The memory half genuinely works (`brain_search`/`brain_ingest_lesson`
calls are real, verified in `terransoul-proxy-calls.jsonl`) — but the
HARNESS half the owner's own words describe ("enforce harness to make the
run self-improved") is entirely absent, because it lives only inside
`packages/terransoul-cli`'s loop, which nothing in this campaign has invoked
through Harbor. That is very likely why `claimed-success-but-failed` is the
dominant finding across every completed trial in both sweeps: nothing
verifies the agent's self-declared "done" before the trial ends, because the
one mechanism TerranSoul has for that never gets to run.

**A real Harbor adapter for this already exists and is further along than
the open-items list below suggests.** `terransoul_cli_agent.py` (this
directory) is a complete `BaseInstalledAgent` implementation —
`SUPPORTS_ATIF: bool = True`, no Claude Code on the path, installs the CLI
via `npm install -g` a packed tarball, deadline-aware, holds no task logic —
and §7a-7k above already validated the underlying CLI end-to-end against
real TB3.0 tasks (real trials, real ATIF trajectories, a real A/B against
Claude Code). Its docstring targets Fable 5 specifically, though the CLI
itself is not proxy-specific (§7a: matches Claude Code's own flags,
Anthropic SDK path). `jobs-terransoul/ts-gated-20260816-151313` is the one
attempt in this repo to run it as an actual Harbor job — the directory
exists and is completely empty, no `config.json`, no trial, no log: it never
got past being created.

> **⚠️ THE RECOMMENDATION BELOW THIS POINT IS RETRACTED — 2026-08-17.** This
> paragraph used to end by calling switching the campaign's agent from
> Claude Code to `terransoul-cli` "very likely the highest-leverage next
> step." Put to the operator rather than acted on, and the answer was no —
> that direction is backwards. **TerranSoul is not a coding agent and is not
> meant to replace Claude Code as the one driving a benchmark sweep.** It is
> the orchestrator/MCP/memory/harness/obs&eval layer *for* coding tools
> (Claude Code, Codex, others); `packages/terransoul-cli` is for small,
> well-scoped execution or for when no other coding tool is present, not for
> sustained large-scale autonomous work like a 74-task sweep. Owner statement
> preserved verbatim in `.github/copilot-instructions.md` → "TerranSoul's
> Role for External Coding Agents" and `rules/architecture-rules.md` rule
> 14b — read those before proposing this pivot again.
>
> **What survives:** the `harness:null, memory:null` finding two paragraphs
> up is still real and still the right lead on `claimed-success-but-failed`.
> What changes is the FIX direction — not "run TerranSoul's own loop
> instead of Claude Code," but "deliver TerranSoul's harness discipline
> (the verify-before-stop discipline `ReviewOnStopGate` encodes) TO Claude
> Code via MCP" — a tool call the agent is expected to make before declaring
> done, or `initialize`/extra-instruction guidance that states the
> discipline, the same pattern already used for memory (§ above, "Available
> to you: a persistent memory server"). That is the actual next architecture
> item, still unstarted, and still worth the operator's sign-off on shape
> before it costs anything.

### That architecture item, done

`brain_verify_completion` and `brain_observe_outcome` were on the MCP wire
(`EXPOSED_TOOLS`) but never described in `SERVER_INSTRUCTIONS` — the text
every MCP client receives at `initialize`. Traced to commit `f3f82913`
(2026-08-16): it added both tools to the wire with a reachability test, but
the pre-existing test that checks the instructions actually NAME every wired
tool (`server_instructions_describe_exactly_the_exposed_tools`) was left red.
Confirmed empirically, not just from the test: **zero real invocations of
`brain_verify_completion` across all 7 live trials in both sweeps this
session.** The tool that answers "am I actually done" was reachable the whole
time and never once called, because nothing told the agent to call it.

Fixed in `src-tauri/src/ai_integrations/mcp/tools.rs` — the server's own
`SERVER_INSTRUCTIONS`, so it reaches every MCP client identically (Desktop,
`terransoul-cli`, the `terransoul-mcp` stdio bridge, and this benchmark's
Claude Code) rather than a bench-only prompt file. Verified in four stages:
unit test red→green, the full `ai_integrations::mcp::tools` module (55/55),
the CI-exact clippy gate, and — because a committed fix and a deployed one
are different claims — a live `initialize` probe against the restarted
production server confirming the new text is actually served now.

One unrelated defect found and fixed along the way, running the same clippy
gate: `crates/memory/src/embedding_queue.rs` carried a duplicated `#[test]`
attribute that had silently orphaned `fetch_due_batch_respects_next_retry_at`
as dead code — restored, and confirmed it genuinely passes rather than merely
compiles.

**What this fix does NOT establish**: whether the agent actually calls
`brain_verify_completion` now that it is told about it. An instruction the
agent may decline is not a guarantee (lesson 25919, the same caution that
applies to the memory-tools guidance already in `SERVER_INSTRUCTIONS`). That
is the next thing to measure, empirically, on a real trial — not assumed
from the fact that the text now exists.

### Measured it. The answer is no — and that turns out to be the expected result.

Redid the same 3-task subset a third time (`tslearn-verifygate-20260817-013445`,
same architecture, fix live and confirmed served through the full proxy
chain before launch). 3/3 completed, 1 `AgentSetupTimeoutError` (the same
transient class as before — now confirmed to recur occasionally rather than
being a strict one-off), `memcached-backdoor` passed again (reward 1.0, 37 min
total job runtime), `session-window-debug` failed again (reward 0.0).

**Checked the raw stream directly for real `tool_use` invocations, not
assumed from the analyzer summary: zero calls to `brain_verify_completion` or
`brain_observe_outcome` in either completed trial.** The fix is deployed,
confirmed served, and did not change what the agent chose to do. n=2 is too
small to call this conclusive on its own, but it is not a surprising result —
it is the literature's default finding.

**Audited online, per the owner's own instruction to do so before continuing
to iterate blind.** Two things converge:

1. ["From Confident Closing to Silent Failure: Characterizing False Success
   in LLM Agents"](https://arxiv.org/pdf/2606.09863) — false success (the
   agent declares done, the outcome is wrong) accounts for 44–52% of failures
   on tau2-bench and 75.8% on AppWorld among architectures with an explicit
   completion signal. Reasoning models are not protected: the highest
   false-success rate measured (79%, Qwen3-Max-Thinking) belongs to a
   reasoning model, because "reasoning traces rationalize completion rather
   than verify it" — which is exactly the shape of `claimed-success-but-failed`
   this campaign keeps finding. The same paper found LLM-judge monitoring
   (which is `brain_verify_completion`'s own fallback path when no objective
   signal is supplied) caps out at AUROC 0.65 across 5 judge models, because
   judges anchor on confident closing language as evidence of completion —
   worth remembering before trusting that fallback path either.
2. Claude Code ships a purpose-built mechanism for exactly this: a **Stop
   hook**. Unlike an MCP tool description, which is advice the model can
   decline (measured: it did), a Stop hook is enforced by the harness itself
   — it fires when the agent is about to end its turn, and exit code 2 blocks
   the stop and re-injects the hook's stderr as a new instruction, forcing
   another turn rather than asking nicely for one.

**Conclusion, acted on.** The right next step is a Stop hook that calls
`brain_verify_completion` and blocks completion on an unverified or failed
result — a deterministic gate, not more advisory text. This is a real new
capability (a hook script + wiring), not a documentation fix, so getting
the exact Claude Code hook contract right (settings.json shape, stdin schema,
exit-code semantics under headless `--print` mode specifically, since that is
what a Harbor container actually runs) comes before writing anything.

### The hook, built and locally verified — not yet on a real trial

Got the exact contract from Claude Code's own docs (via the `claude-code-guide`
agent) rather than trusting the blog-post summaries the first search turned
up, which flagged headless-mode behaviour as genuinely undocumented. Resolved
that uncertainty CHEAPLY, locally, before spending anything on a benchmark
container:

1. A minimal `.claude/settings.json` + hook script, run against
   `claude --print --output-format=stream-json --permission-mode=bypassPermissions`
   — the exact flags Harbor uses. Blocked the first stop with a reason
   ("say BANANA"); the model's own final `result` text was `"BANANA."`. The
   block-and-reinject mechanism works under headless mode. Confirmed, not
   assumed.
2. A second local run with 2+ tool calls, to answer a question the research
   didn't cover at all: does `Stop` fire once per session or once per turn?
   Once. Exactly one hook invocation for a multi-tool-call session. That is
   what makes one `brain_verify_completion` call per trial the right cost
   instead of noise.

Built on that foundation: `packages/terransoul-cli/src/stop-hook.mjs`
(`extractGoal` reads the task instruction straight from Claude Code's own
transcript JSONL — the first `user` turn — so the hook needs no separate
channel for "what was this trial supposed to do"; `decideStop` fails open on
every error path: unreachable MCP, unreadable transcript, malformed verdict,
and — to respect Claude Code's 8-consecutive-block hard cap — never blocks
twice in the same turn, checked via `stop_hook_active`). `terransoul
stop-hook` wires it to real stdin/stdout. 12 tests, including one that runs
the actual CLI process end-to-end against a fake MCP server, not just the
pure function. Commit `50a5303a`.

**Harbor wiring, discovered rather than assumed.** Read `claude_code.py` and
`base.py` in the installed Harbor package directly: the stock `claude_code`
agent (no custom Python agent class needed) already supports a `--settings`
layer — `agent.kwargs.config` (a dict or a path) populates
`BaseInstalledAgent.config_source`, and the agent uploads it and appends
`--settings <path>` to the `claude` invocation automatically. A Stop hook can
be registered on a stock `claude-code` Harbor job through `JobConfig` alone.
(Codex's agent has the identical `config_source` mechanism for its own TOML
config — worth remembering given the owner's TS-ROLE-1 principle that
TerranSoul should orchestrate more than one coding tool.)

**What's still missing, and it's the only thing left:** the container has no
`@terransoul/cli` installed, so `terransoul stop-hook` is not yet a command
that exists to run. The stock agent's `install()` has no extension point for
an extra package; the fix is a thin custom agent subclass that does
everything `claude_code` already does plus one `npm pack && npm install -g`
step — the same shape `terransoul_cli_agent.py` already uses for the
CLI-as-agent path, just far smaller since this one doesn't replace the agent,
it only adds one file to the container.

### Built, wired into a real Harbor job, and it works — a second real bug found on the way

`terransoul_verify_hook_agent.py`: a thin `ClaudeCode` subclass adding exactly
one install step. Registered via `agent.import_path` +
`agent.kwargs.config` (the `--settings` mechanism found by reading Harbor's
own source, above) — validated with `--print-config` before spending
anything.

**Two more real bugs found before any container ran**, both would have made
the whole mechanism silently useless:

1. `mcp-auth-proxy.mjs` (this campaign's only proxy, reused unmodified from
   the 2.1 archive all session) has a tool allowlist that predates
   `brain_verify_completion`/`brain_observe_outcome` (added 2026-08-16) —
   confirmed live, calling the tool through the proxy returned the
   `-32001 blocked` refusal every time. Now committed to
   `benchmark/terminal-bench-3.0/` (closing the "this campaign has no
   committed proxy" gap too) with `brain_verify_completion` added to
   `READ_ONLY_TOOLS` (its only op this hook calls, `verify`, does not mutate
   `memories`) and `brain_observe_outcome` to `LEARN_TOOLS`.
2. `McpClient.callTool` joined the compliance gate's own operator-facing
   annotation block straight into the tool's answer text — confirmed live,
   a real `brain_verify_completion` call through the proxy came back as TWO
   content blocks, and `JSON.parse`ing the joined string threw. **Not
   new-code-only**: `memory.mjs` and `budget.mjs` had the identical latent
   bug on every real session with unmet preflight — which is the normal
   state for the first several calls of every session, including every real
   trial. Fixed once, centrally, in `callTool()` (commit `1edac349`).

**First Harbor launch failed on a Python import error** (`terransoul_verify_hook_agent`
not on `sys.path` when invoked from the repo root) — the same fix
`run-terransoul.sh` already applies (`export PYTHONPATH="$HERE"`), just
forgotten in the ad-hoc launch. No container work had started; nothing to
clean up beyond the empty job directory.

**Second launch: fully confirmed working, end to end, in a real container.**
`job.log` shows, in order: `npm install -g /tmp/terransoul-core-0.1.0.tgz
/tmp/terransoul-cli-0.1.0.tgz` succeeding, `command -v terransoul` succeeding,
and the real `claude` invocation carrying `--settings
/tmp/claude-code-settings/settings.json` — Harbor's own upload mechanism
firing exactly as its source promised.

**The proxy's own call log (`TB_PROXY_LOG` unset this run, so console-only —
noted for next time) shows real `brain_verify_completion` calls landing
during the actual trial run window, not my earlier manual testing.** This is
the first time in this entire campaign that TerranSoul's verify-before-stop
mechanism has been exercised by a real trial, at all.

**The honest result, checked against the raw data rather than assumed:**

| trial | reward | brain_verify_completion called | judge said | blocked? |
|---|---|---|---|---|
| session-window-debug | 0.0 | yes | `verified: true` | no |
| mvcc-lsm-compaction | 0.0 | yes | `verified: true` | no |
| memcached-backdoor | excluded — see below | — | — | — |

Neither of the two completed trials' transcripts contain the hook's own
block-reason text anywhere (`grep`ped directly, not inferred), which — given
the proxy log confirms exactly one `brain_verify_completion` call per
trial — means the LLM-judge fallback (no objective signal available for
these tasks) said `verified: true` on both, on the first and only ask, even
though both trials were wrong.

**The mechanism worked exactly as designed. It did not change the outcome,
because the judge agreed with a confident wrong answer.** This is not a
wiring failure — it is precisely the limitation the research already named
before any of this was built: "no configuration across 5 judge models and
prompt strategies exceeds AUROC 0.65 [on tau2-bench]... judges anchor on
confident closing-message language as evidence of completion." Enforcement
was the missing piece for making the agent ask at all — now proven fixed.
Judge accuracy is the next, different, harder bottleneck, and it was always
going to be reached only after enforcement existed to expose it.

**The third trial is excluded, not scored zero.** `memcached-backdoor`
failed after 44m 43s with `API Error: 401 OAuth access token has expired` —
the exact risk named and accepted when the operator approved reusing this
session's own live credential ("a token refresh/re-login here could kill
in-flight trials," checkpoint above). It happened, for real, this run. Not a
defect in the hook, the proxy, or the agent — the cost of the shared-token
decision, and evidence for using a dedicated token (the other option offered
at the time) on any future run long enough to risk a refresh mid-flight.

**What this changes going forward:** the harness-enforcement half of "make
TerranSoul's harness actually run" is done and proven. The next lever is
`brain_verify_completion`'s own judge quality — plausibly worth wiring in
whatever objective signal Terminal-Bench trials can supply (task-specific,
so it cannot live in this file as a rule, but the tool's own
`objective_delta` fast path exists for exactly this), or hardening the judge
prompt against confident-closing-language bias specifically, per the same
paper.

### The judge-prompt fix, validated on fresh real trials — a real but limited effect

Fixed `verify_completion_system_prompt` in `gateway.rs` (commit `6a784d82`):
replayed the two real false-positive (goal, actions) pairs from the run
above through the same local judge model with an improved, evidence-
demanding prompt before touching production code. One of the two flipped to
correctly unverified; the other did not. Also fixed a separate bug found on
the same replay — the model wrapped one otherwise-correct answer in
` ```json ` fences despite being told not to; `strip_json_fences()` now
defends against it generically. Rebuilt, restarted, then redid the same
3-task subset a fifth time (`tslearn-judgefix-20260817-124241`) to see
whether the fix moved anything in the wild, not just on the two replayed
cases.

**3/3 completed, 0 exceptions, all three reward 0.0** — including
`memcached-backdoor`, which passed in both of the two prior runs. Real
capability variance on a hard task, not a regression from anything here.

**The proxy log confirms `brain_verify_completion` was called FOUR times
this run, not three** — one call each for `session-window-debug` and
`mvcc-lsm-compaction` (same as before: judge said `verified: true` on both,
still wrong, the improved prompt did not change either verdict this time),
and TWO calls for `memcached-backdoor`.

**`memcached-backdoor`'s own stream shows something that did not happen in
any prior trial: two `system:init` events and two `result` events inside
one Harbor-level agent invocation** — a 177-turn "leg" (`total_cost_usd`
$15.72), immediately followed by a second, shorter one (9 more turns,
cumulative cost $18.66). `trial.log` confirms Harbor invoked `claude` only
ONCE for this trial (no Harbor-level retry), so the second leg happened
*inside* that one process — structurally consistent with the Stop hook
having actually blocked once and forced a continuation, which is what two
verify calls plus a second init plus real added cost and turns would look
like from the outside.

**Honestly incomplete:** searching the raw stream for the hook's own
block-reason text (`"TerranSoul verification"`, the literal string this
hook emits) found zero matches anywhere in the file, including inside
subsequent `user` turns. Either Claude Code re-injects a Stop-hook block
reason through a channel this transcript format doesn't render as visible
text (plausible — nothing in the researched contract says the reason must
appear as a chat message), or the second leg has some other cause unrelated
to this hook. Not resolved with confidence either way; recorded as an open
question rather than claimed as proof, per this file's own standing
discipline about not asserting a mechanism claim past what was actually
verified (see §7h's retraction, above).

**What's solid, independent of that ambiguity:** the judge fired for real
on all three trials this run (proxy log, not inferred), the prior fix's
partial real-world effect (helps some cases, not others) held up on
genuinely fresh trials rather than being an artifact of the two replayed
cases, and no trial errored — the earlier token-expiry risk did not recur
this run.

Given the scope already spent this session (five real sweeps, four shipped
product fixes, one architecture course-correction, one working harness-
enforcement mechanism proven end to end, one judge-prompt improvement with
an honestly partial and now further-qualified effect), this
is the natural checkpoint to report back before spending further.
