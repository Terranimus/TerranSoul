> **ARCHIVED — Terminal-Bench 2.1.** This document belongs to the closed 2.1
> campaign (Claude Code agent loop + `claude-sonnet-5`). It is retained for
> provenance and is **not** current guidance. The active campaign is
> Terminal-Bench 3.0; see `benchmark/terminal-bench/`.
# Terminal-Bench 2.1 — submission recon and plan (2026-08-02)

> Produced by a 5-agent recon workflow. **Verdict: NO-GO until 0.1.0 ships.**
> This document is the pickup-cold reference for Phase TBENCH in `rules/milestones.md`.
>
> ⚠️ Two claims made in chat BEFORE this recon were wrong and are corrected inside:
> (1) "zero open-source models on the board" — the 58.7% floor entry, GLM-5.1, is a large
> frontier-class OPEN model, so the open-weights first is likely already taken; the surviving
> claim is "first entry executed entirely on local consumer hardware, no external API call".
> (2) The memory layer alone is not projected to clear the Option-B bar — see §1.
>
> ⚠️ **(3) CORRECTED 2026-08-02 after an owner challenge: "TerranSoul has no shell" is WRONG.**
> `crates/coding/src/execute_code.rs` executes shell (`bash`/`sh` -> `sh <script>` / `cmd /C
> <script>`), exposed as `brain_execute_code` over MCP with risk gating and seeded config. The
> real gap is that it is ONE-SHOT SANDBOXED EXECUTION, not a session: a fresh temp dir per call,
> `.current_dir()` inside it, and a SCRUBBED child env, so `cd`/`export` cannot persist; no PTY;
> and it runs in a throwaway dir rather than the task's filesystem. Correct for untrusted chat
> code, wrong for a terminal agent. **TB-2 is therefore an upgrade of an existing execution path,
> not a from-zero build, and its 5-8 day estimate should be re-scoped against that file before
> being trusted.**

---

## 1. FEASIBILITY VERDICT AND PLAN

# TerranSoul → Terminal-Bench 2.1: SUBMISSION PLAN

---

## 1. FEASIBILITY VERDICT

# **NO-GO NOW. Hard defer the entire campaign to post-0.1.0.**

**Single strongest reason:** this is a **from-scratch terminal agent build (~25–40 engineer-days)**, not a submission — TerranSoul today has a two-tool `read_file`/`edit_file` agent with `stdin` nulled everywhere, no PTY, no persistent cwd, no session, no Harbor adapter and no ATIF emitter — and it would compete directly against a release the repo itself records as **"a multi-week release"** (owner decision 15) that is currently **blocked**: nothing committed since `9075fb03`, the charts are not live because of it, `INSTALLER-4` is blocked on elevation, `SEED-FLATTEN-FIX` reverted twice, and the ladder-unification work exists **only** as uncommitted files in `.claude/worktrees/wf_9bbf0a81-2d0-1` with a hand-reconcile owed. Starting Terminal-Bench now spends the one GPU, the one bench slot, and the release-critical attention budget on a leaderboard row.

**The second, structural reason — which is why this cannot be squeezed in "small":**

The claim we want (`TerranSoul + Opus 4.8 > Claude Code + Opus 4.8`) requires **≈ +3.6 pp at 2 SE**. The differentiator we want to isolate — the memory layer — projects to **+1 to +2.5 pp** on Opus-class models (published proactive-memory decay: Sonnet 4.5 +8.3 → Opus 4.6 +2.4, a 3.5× fade). **The thesis does not reach the bar.** Everything that *would* reach the bar (deterministic startup retry +2–5 pp, exit gate, effort sandwich +2.9 pp, bootstrap snapshot +1.7 pp, anti-premature-submission) is generic harness engineering — where our v1 scaffold would be competing against Anthropic's own multi-year-tuned scaffold on its home turf. That is a coin-flip we would be paying $1,500–$3,500 and publishing **permanently** to resolve.

**GO condition (unhedged):** start Phase TBENCH the day `0.1.0` ships and `INSTALLER-4` is green. Not before. The plan below is written to be picked up cold on that day.

---

## 2. WHICH SUBMISSION

# **Option A first. Option B is a gated stretch, not a target. Neither ships before 0.1.0.**

**Option A is NOT impossible.** Recon A settled it: Harbor calls models through LiteLLM, and `api_base` is documented as *"useful for local or proxy endpoints."* Confirmed working config exists (`hosted_vllm/…` + `api_base` + `input_cost_per_token: 0.0`, `network_mode: host`). Our `openai_agentic.rs` is already the gemma4 transport. Option A is mechanically live.

**Why A first, decisively:**

| | Option A (local gemma4:12b) | Option B (Opus 4.8, target >78.9%) |
|---|---|---|
| Model cost | **$0** (`input_cost_per_token: 0.0`) | $430–720/run; $1.5k–3.5k campaign |
| Claim shape | **Category first** — cannot be "lost" | **Comparative** — 50/50 at best, permanent if lost |
| Where our differentiator has headroom | **Large** (harness/memory gains peak on weak models: +14–21 pp Self-Harness, +8.3 pp memory on Sonnet-class) | **Under the noise floor** (+1 to +2.5 pp vs +3.6 pp needed) |
| Shared engineering | — | **~90% identical** (TB-1..TB-7 serve both) |
| Main cost | ~99 serialized GPU-hours = 4–10 days of the single bench slot | money + reputational exposure |

A-first is not a detour: **TB-1 through TB-7 are the same code for both arms.** If A's harness proves out and the ablation shows a real episode-memory delta, B becomes a *funded* decision with evidence behind it instead of a hope.

**Two corrections to the framing, both load-bearing:**

1. ⚠️ **"ZERO open-source models on the board" is probably false.** Recon A identifies the 58.7% floor entry as **GLM-5.1, "a large frontier-class open model."** The open-weights claim may already be taken. The surviving, defensible claim is narrower and better: **"the first entry executed entirely on local consumer hardware with no external API call."** TB-0 verifies this before a single line is written; if it fails too, Option A loses its claim and the whole campaign reverts to NO-GO.
2. **If Option B ever ships, its honest name is "TerranSoul harness," not "TerranSoul memory."** The memory layer is one pre-registered ablation arm, and we must be willing to publish *"memory contributed ≈0."*

---

## 3. IMPLEMENTATION PLAN — paste-ready for `rules/milestones.md`

```markdown
## Phase TBENCH — Terminal-Bench 2.1 submission (POST-0.1.0, owner-gated)

> ⛔ **HARD GATE: no chunk in this phase starts before 0.1.0 ships and INSTALLER-4 is green.**
> Rationale: TB-10/TB-12 each consume the single bench slot for 4–10 days
> (`rules/bench-resource-discipline.md`: one bench at a time, one MCP).
>
> Order is strictly linear TB-0 → TB-12 except where noted. Rust chunks are
> cargo-serialized (`-j 1`). TB-6 (Python adapter) may run parallel to TB-4/TB-5.
>
> **Scope rule for this phase:** every chunk must survive the task text changing.
> Nothing here may detect the harness, special-case a task id, or persist across
> episodes. See `rules/bench-agi-purity.md` and §6 of the submission plan.
>
> Total effort ≈ 25–40 engineer-days. Full plan + costed dry-run in
> `docs/terminal-bench-submission-plan.md` (write at TB-0).

| Chunk | What | Acceptance criteria | Effort | Status |
|---|---|---|---|---|
| **TB-0** | **Kill-gate + claim verification.** Ask maintainers: (a) does the leaderboard's *"a Terminal-Bench team member ran the evaluation"* note gate self-run submissions, or is it a per-entry provenance note? (b) is the 58.7% GLM-5.1 entry open-weights? Write `docs/terminal-bench-submission-plan.md`. | Written maintainer answer (issue/PR/Discord, linked in the doc). **If self-run numbers are not authoritative → phase ABORTS.** **If GLM-5.1 is open-weights → the Option-A claim is reworded to "first entry executed entirely on local consumer hardware, no external API," or the phase ABORTS.** No spend before this closes. | 0.5 d | not-started |
| **TB-1** | **Harbor smoke, zero model cost.** Install `harbor`, run `harbor run -d terminal-bench/terminal-bench-2-1 -a oracle -l 5 -k 1` against **local Docker** (not Daytona). Clone `badlogic/pi-terminal-bench` as the reference adapter; note its `upload_dir` patch. | Oracle scores 5/5 on 5 tasks; `/logs/verifier/reward.json` readable; a trajectory file inspected by hand. $0 model spend. | 1 d | not-started |
| **TB-2** | **Persistent shell-session primitive** in `crates/coding` (`portable-pty`). Real PTY, persistent cwd + env across calls, per-command timeout that does NOT kill the session, interactive-prompt read/write, UTF-8-safe head+tail truncation with byte counts, exit-code capture. **Product-useful beyond TB** — the coding agent has no shell today. | Unit tests: cwd persists across 3 calls; `export X=1` visible in call 2; a 30 s command times out and the session survives call 3; `read -p` prompt answered; 1 MB output truncates without splitting a UTF-8 codepoint; exit code 127 surfaced verbatim. | 5–8 d | not-started |
| **TB-3** | **`AgentProfile::Container` bench-safety profile.** Opt-in only. Permits destructive commands *inside the container*; relaxes `SecretsDenylist` path tokens (`sandbox.rs:13-20`); grants `ActionCategory::CodeExecute` at cold start (bypasses `action_trust.rs` Laplace gate); forces `CodeActConfig::self_improve = false`; redirects `offload.rs`'s `.terransoul/` dirs **outside the task workdir**. | Table test proves **desktop/CLI defaults byte-identical** to today (`rm -rf` still → Ask, `CodeExecute` still deny-by-default). Container test proves `rm -rf ./build` runs, and `git status`-equivalent on the task cwd shows **zero unintended files**. Brain row-count diff before/after a 5-task run = **0 writes**. | 2–3 d | not-started |
| **TB-4** | **Terminal agent loop.** Shell-only tool surface over TB-2. Carries over from `openai_agentic.rs`: truncation-continuation (`MAX_CONTINUATIONS`), `IterationBudget`. Adds: (a) **budget as an observable** — turns used/remaining AND wall-clock elapsed/remaining in every tool result; (b) in-loop compaction + context-overflow handoff ritual; (c) **exit gate** — no final answer without ≥1 passing verification command, classified by `memory/verification.rs`'s exit-code-only classifier, promoted from post-hoc (`cli.rs:2276`) to in-loop and made transport-agnostic (today it is dead on the CLI arm, keyed on `edited_paths` which `agentic_cli.rs:74-80` documents as always empty); (d) anti-premature-submission two-phase confirm, replacing `openai_agentic.rs:506-508`; (e) **reasoning-effort sandwich** via the existing `anthropic_client.rs:153-165` dial — high/plan, medium/implement, high/verify; (f) turn-1 environment bootstrap snapshot; (g) capability-probe cache (missing-executable negative facts). | End-to-end on 5 scripted local tasks. Loop **cannot** emit a final answer with zero verification commands (asserted by test). Effort schedule visible in the emitted trajectory. Wall-clock remaining present in every tool result. | 8–12 d | not-started |
| **TB-5** | **Within-episode ledger — THE DIFFERENTIATOR, and it must be ablatable.** Wire `shared-types/loop_detect.rs` (pure, currently reachable only from desktop chat, `streaming.rs:8277`) and `memory/traces.rs` (`write_trace`, currently chat-only) into TB-4. Dead ends injected as **negative constraints scoped to the current subgoal only**, and they must survive compaction. Runtime flag `--episode-memory on\|off`. No cross-episode persistence, ever. | Synthetic task: the same failing command proposed 3× fires `DeadEndSignal` and the next prompt contains the negative constraint. With `off`, prompts are **byte-identical** to a no-memory build (this is what makes the ablation arm valid). Brain DB unchanged across two consecutive episodes. | 3–5 d | not-started |
| **TB-6** | **Harbor `BaseAgent` adapter + ATIF emission.** Thin Python that shells to the TerranSoul binary and streams — **no task logic in the bridge** (`rules/mcp-single-source-of-truth.md`). `SUPPORTS_ATIF = True`. ATIF is a **hard CI gate**; our `brain_export_trajectory` writes ShareGPT from a table the agent path never populates, so this is new. May run parallel to TB-4/TB-5. | `harbor run --agent-import-path terransoul_tb:TerranSoulAgent -l 1 -k 1` yields a trial with non-null `trajectory_path` validating against ATIF. Adapter is < 300 lines and contains zero task/branching logic. | 3–5 d | not-started |
| **TB-7** | **Dry-run gauntlet stages 0–3** (see §4 of the plan). Local Docker only. Hard ABORT gate at each stage. | Stage 3 (`-l 10 -k 1`, Opus 4.8, ≈$15) completes with 10/10 non-errored trials. **Errored trials score 0 and are not excluded — a startup/adapter flake is a lost point.** | 2 d | not-started |
| **TB-8** | **Deterministic startup + retry (A1).** Idempotent session handshake, bounded retry on container/agent init, structured failure that never silently yields a scored-0 trial. **Highest-certainty scoring item on the list (2–5 pp of pure arithmetic).** | 100 consecutive synthetic startups: 0 unhandled init failures. Injected transient failure recovers within the retry budget and is logged as recovered, not as a task failure. | 2 d | not-started |
| **TB-9** | **Pre-registration.** Commit `docs/terminal-bench-preregistration.md` **before** any full run: hypothesis, arms (`--episode-memory on/off`), primary metric, stop rules, and the explicit numbers under which we publish *"memory contributed ≈0."* Record that publishing a TB accuracy immediately binds it under `rules/bench-never-regress.md`. | Doc committed and dated **before** TB-10 starts. Names the falsifying outcome in numbers, not prose. | 0.5 d | not-started |
| **TB-10** | **Local arm (Option A) full run.** gemma4:12b via `api_base` + `network_mode: host`, `input_cost_per_token: 0.0`. 89 × 5 = 445 trials, ~99 serialized GPU-hours. **Consumes the single bench slot for 4–10 days — cannot overlap with any p-50/LongMemEval work.** | All 445 trials complete, 0 errored. Both ablation arms run. Numbers recorded but **NOT published** yet. | 4–10 d wall | not-started |
| **TB-11** | **Trajectory self-audit before going public.** Sample 10 successful trajectories; audit against the public judge's four criteria (harness cheating, reward hacking, refusals, missing trajectories). Confirm zero brain writes, zero `.terransoul/` litter, zero cross-episode state. Then `--upload --public` + `lb submit`. | Self-audit doc; every sampled trajectory clean. Only then is the PR opened. **This is the last reversible moment.** | 1 d | not-started |
| **TB-12** | **Opus 4.8 arm (Option B) — CONDITIONAL, owner-signed.** Runs **only if** TB-10's ablation shows an episode-memory delta larger than the p-50-style noise band, AND owner signs off on $430–720/run. Dry-run stage 4 (`-k 1` × 89, ≈$115) is a hard gate: if it does not land within ~5 pp of 78.9, **do not buy the 5-trial run.** | Stage-4 gate passed; owner sign-off recorded; then 445 trials, both arms, self-audit, submit. | 4–6 d + $ | not-started |
```

**Dependency order:** `TB-0 → TB-1 → TB-2 → TB-3 → TB-4 → TB-5 → TB-7 → TB-8 → TB-9 → TB-10 → TB-11 → TB-12`, with `TB-6` parallel to `TB-4/TB-5` and joining before `TB-7`.

---

## 4. COSTED DRY-RUN PATH

**Total to a defensible go/no-go on the Opus arm: ≈ $130 of model tokens** — versus $430–720 for one full 5-trial run. Every stage has an abort gate; run stages 0–3 on **local Docker**, not Daytona, because sandbox compute is billed separately and is unpriced in Recon A.

| Stage | Command | Model cost | Proves | ABORT if |
|---|---|---|---|---|
| **0** | `harbor run -d terminal-bench/terminal-bench-2-1 -a oracle -l 5 -k 1` | **$0** (oracle runs `solve.sh`) | harness install, sandbox, `reward.json` plumbing | oracle ≠ 5/5 → our environment is wrong, not our agent |
| **1** | our adapter + **local gemma4**, `-l 1 -k 1`, one *Easy* task | **$0** | `--agent-import-path` resolves; ATIF emitted; container→host networking reaches Ollama | no `trajectory_path` → TB-6 is not done |
| **2** | our adapter + local gemma4, `-l 5 -k 1` | **$0** | the loop survives 5 real tasks without hanging, littering, or writing to the brain | any `.terransoul/` file in the task cwd, or any brain row written |
| **3** | our adapter + **Opus 4.8**, `-l 10 -k 1` | **≈ $15** (10 × ~$0.65 × ~2× scaffold overhead) | the Opus arm works end-to-end; effort sandwich visible; cost/trial measured | any errored trial (errored = scored 0, not excluded) |
| **4** | our adapter + Opus 4.8, **all 89, `-k 1`** | **≈ $115** | **the decision point.** Single-trial accuracy across the real distribution | **< ~74% → do not buy the 5-trial run.** A 5-trial run cannot rescue a scaffold that is 5 pp behind at `k=1` |
| — | **Full 5-trial run** | $430–720 | the submission | — |

**Do not pass `--upload` during stages 0–4.** Submission requires the job *and every trial* to be publicly readable on Harbor Hub; keep dry runs entirely local so nothing half-built is ever indexed.

**Local-arm equivalent of stage 4:** `-k 1` × 89 on gemma4 costs **$0 in tokens but ~20 GPU-hours**. Run it, and treat it as the same decision point — if the local agent scores 0/89 twice, the honest report is *"a 12B model cannot drive a shell within these budgets,"* and we publish that finding instead of a leaderboard row.

---

## 5. RISKS AND MITIGATIONS

| # | Risk | Mitigation |
|---|---|---|
| **R1** | **A public submission is PERMANENT and INDEXED.** The row, the accuracy, the cost, the `reward_hacks` count, and **all 445 trajectories** are publicly readable forever. A 78.1% next to Claude Code's 78.9% is a permanent, searchable record of our scaffold losing on the same model. | Never `--upload --public` before TB-11. Stages 0–4 run fully local. Option A first — a category claim cannot be "lost." Option B is gated on a $115 stage-4 result, not on hope. |
| **R2** | **Maintainers + an LLM judge review the trajectories** for harness cheating, reward hacking, refusals and missing trajectories; the **"Hacks" column is public** (the Opus 4.7 entry publishes `reward_hacks: 0.45` and two disqualified trials). | TB-11 self-audit of 10 sampled trajectories against those exact four criteria, before the PR. Our own binding rules (`bench-agi-purity.md`, "no answer-derived seeds") already forbid every technique the judge looks for — §6 makes it explicit for the implementer. |
| **R3** | **Cross-episode learning leak reads as test-set training.** `CodeActConfig::self_improve` defaults **true** (`code_act.rs:109`) and persists successful snippets; `brain_execute_code` writes the procedural ledger and can auto-fire skill synthesis. Across 445 trials that is learning on the test set. | TB-3 forces `self_improve = false` in the container profile, with an acceptance test asserting **zero brain rows written** across a 5-task run (row-count diff). State it explicitly in the submission notes rather than waiting to be asked. |
| **R4** | **`.terransoul/` litter changes final container state.** `offload.rs:35/38` writes `<worktree>/.terransoul/tool_results/` and `/shell_output/`. TB tests inspect **final container state** — a stray directory can flip a pass to a fail, and all-or-nothing scoring means one flip = one lost point. | TB-3 redirects offload outside the task workdir; acceptance test asserts the task cwd contains only intended changes. |
| **R5** | **The bench-safety profile leaks into shipped defaults**, trading a leaderboard row for a product security regression. `rm -rf` → Ask, `CodeExecute` deny-by-default, and the `SecretsDenylist` are deliberate desktop-resident design, not oversights. | TB-3 is a **profile**, opt-in at runtime, never the default. Its acceptance criterion is a table test proving desktop/CLI defaults are byte-identical to today. |
| **R6** | **The memory thesis fails to move the number** (+1 to +2.5 pp projected vs +3.6 pp needed) and we have publicly staked a memory claim. | TB-9 pre-registration names the falsifying numbers *before* the run. TB-5's `off` arm must produce byte-identical prompts so the ablation is real. If the submission ships, it ships as **"TerranSoul harness."** |
| **R7** | **The "first open-source / local" claim may already be false** — Recon A calls the 58.7% GLM-5.1 entry a large frontier-class open model. | TB-0 verifies before any spend. Reworded claim: *"first entry executed entirely on local consumer hardware with no external API."* If that fails too, the phase aborts — we do not ship a low-scoring row with no claim attached. |
| **R8** | **Publishing a TB accuracy immediately binds it** under `rules/bench-never-regress.md` — every future scaffold change must re-clear it or trigger the investigate→optimize→rebench loop, at $430–720 or 99 GPU-hours a cycle. | Recorded explicitly in TB-9. Do not publish until the harness is stable. Budget one re-bench per year, not per change. |
| **R9** | **CI auto-rejects** missing/null metadata, modified timeouts or resources, incomplete task coverage, `<5` trials, or any rewarded trial lacking an ATIF `trajectory_path`. | Never touch `task.toml`. TB-6's acceptance is ATIF validation, not "it ran." Run `lb`'s filter/metadata steps locally before opening the PR. |
| **R10** | **The single bench slot is consumed for 4–10 days** by TB-10 — colliding with `rules/bench-resource-discipline.md` (one bench, one MCP, ≤5 bench terminals) and with all p-50/LongMemEval work. | Schedule TB-10 as **the** bench. It cannot overlap. This is a second, independent reason it must wait for post-0.1.0. |
| **R11** | **Sandbox compute (Daytona) is billed separately** and is not in the board's cost column — genuinely unpriced by Recon A. | Local Docker for stages 0–4. Price Daytona explicitly before the full run; if `-n 32` concurrency is needed for wall-clock, get that number in writing first. |
| **R12** | **Self-run authority unresolved** — the leaderboard note says a team member ran and verified the evaluation, while SUBMIT.md documents a self-run flow with no such gate. | TB-0 is a **kill-gate**. If self-run numbers are not authoritative, the phase aborts before a dollar is spent. |
| **R13** | **Scope creep from `crates/coding`.** 53,396 lines of repo-resident IDE machinery (`symbol_index.rs`, `engine.rs`, `worktree.rs`, `multi_agent.rs`) look reusable and are not — they need a pre-built `code_index.sqlite`, a git worktree and `rules/milestones.md`, none of which exist in a TB container. | The plan reuses exactly seven things: `anthropic_client.rs` effort dial, `openai_agentic.rs` loop skeleton + truncation-continuation, `iteration_budget.rs`, `memory/verification.rs`, `loop_detect.rs`, `execute_code.rs` truncation, `test_runner.rs` flaky classification. Anything else pulled in is scope creep — reject it in review. |

---

## 6. WHAT WE WILL NOT DO

Binding on whoever implements this phase. Any chunk that requires one of these is not a chunk — it is a stop-work.

**We will not:**
- **detect that we are inside the benchmark harness**, or branch on any signal that we are being evaluated;
- **special-case known task ids, fixtures, or file paths** from Terminal-Bench 2.0/2.1;
- **hardcode or pre-seed task answers**, hints, walkthroughs, expected outputs, or curated vocab derived from the task set;
- **exploit the scorer or verifier** — no writing to `/logs/verifier/`, no touching `reward.json`/`reward.txt`, no reading or reverse-engineering `tests/test.sh` to satisfy it without solving the task;
- **train, seed, fine-tune or accumulate memory on the test set** — including via `self_improve`, the procedural ledger, or skill synthesis. `--episode-memory` is **within-episode only** and is wiped between trials, and TB-3's acceptance test asserts zero brain writes;
- **modify timeouts, resource limits, `timeout_multiplier`, or any task/environment/verifier config** (also a hard CI reject);
- **build anything whose value disappears if the task text changes.** That is the single test to apply when in doubt.

**Additionally, per this repo's own binding rules** (`rules/bench-agi-purity.md`, `rules/coding-standards.md`, memory: *"never shortcut a bench with seed/harness boost"*, *"no answer-derived seeds"*): the same prohibitions already apply to every bench we run. Terminal-Bench adds a second enforcement layer — public trajectories, an LLM reward-hacking judge, and a public "Hacks" column — but it changes nothing about what we were already required to do.

**On techniques found in the wild:** Recon A confirms such techniques exist and are caught — the Opus 4.7 entry carries two `reward_hacking` disqualifications and a published `reward_hacks: 0.45`. **We are not using them, and this plan builds on none of them.** If a survey turns up more, report the existence and stop there.

**Everything in this plan is in-scope harness engineering** — the axis this leaderboard explicitly ranks, where the agent is a first-class column and Claude Code, Codex and mini-SWE-agent differ by scaffold, not model: shell/session design, context management, error recovery, self-verification before declaring done, budget and clock handling, cwd/state discipline, and within-episode memory of what was already tried.

---

**Relevant files for whoever picks this up:** `D:\Git\TerranSoulApp\crates\brain\src\openai_agentic.rs` · `D:\Git\TerranSoulApp\crates\brain\src\agentic_cli.rs` · `D:\Git\TerranSoulApp\crates\brain\src\anthropic_client.rs` · `D:\Git\TerranSoulApp\crates\memory\src\verification.rs` · `D:\Git\TerranSoulApp\crates\memory\src\traces.rs` · `D:\Git\TerranSoulApp\crates\shared-types\src\loop_detect.rs` · `D:\Git\TerranSoulApp\crates\coding\src\execute_code.rs` · `D:\Git\TerranSoulApp\crates\coding\src\sandbox.rs` · `D:\Git\TerranSoulApp\crates\coding\src\code_act.rs` · `D:\Git\TerranSoulApp\crates\coding\src\iteration_budget.rs` · `D:\Git\TerranSoulApp\src-tauri\src\cli.rs` (1500–2310) · `D:\Git\TerranSoulApp\src-tauri\src\ai_integrations\mcp\tools.rs` (1495–1562).

**No files were changed, no cargo was run, no bench was run.**

---

## 2. RECON A — benchmark mechanics, custom-agent path, cost

## RECON A — Terminal-Bench 2.1: mechanics, custom-agent path, feasibility

**Bottom line: all three blockers clear. Custom agents are a first-class documented path (`--agent-import-path`), local/OpenAI-compatible models ARE drivable (`api_base` + LiteLLM), and self-run submission is the documented flow. Budget ~$300–900 per valid Opus 4.8 run.**

---

### 1. What a Terminal-Bench 2.1 task is

| Property | Value | Source |
|---|---|---|
| Task count | **89** (TB 2.1 = TB 2.0's 89 tasks, 26 modified for bugs/timeouts/reward-hacking robustness) | Hub dataset card, arXiv paper |
| Difficulty | 4 Easy / 55 Medium / 30 Hard, 16 categories (SWE largest) | paper |
| Selection | 89 curated from 229 crowdsourced; hours of human + LM validation each | paper |

**Task = 4 files** (Harbor format): `instruction.md` (the prompt), `task.toml` (config), `environment/` (Dockerfile or compose), `tests/test.sh`, plus optional `solution/solve.sh` for the oracle agent.

**What the agent receives:** the instruction string, and a shell in a Docker container. Nothing else. Terminus 2 (the neutral reference scaffold) exposes *only* Bash.

**Scoring — outcome-based, all-or-nothing.** Tests inspect **final container state**, never the agent's commands or console output. `tests/test.sh` writes `/logs/verifier/reward.json` (or `reward.txt`); Harbor prefers the JSON. **A task with 10 tests where 9 pass scores 0.** Errored trials count as reward 0 and are not excluded.

**Timeouts are per-task and generous.** Real example (`build-pov-ray`): `agent.timeout_sec = 12000` (3h20m), `verifier.timeout_sec = 12000`, 1 CPU / 2048 MB RAM / 10240 MB storage, no GPU, internet enabled. Measured `avg_trial_duration_sec = 799.6` across a full Opus 4.7 run — so the timeout is a safety ceiling, not the operating point. **Submissions may not modify timeouts or resources** — CI statically rejects `timeout_multiplier` ≠ 1.0/None and any agent/verifier/resource override.

---

### 2. Registering a custom agent

**It is a Python class, and the path is documented and exercised by third parties.**

```bash
harbor run -d terminal-bench/terminal-bench-2-1 \
  --agent-import-path "path.to.agent:SomeAgent" -k 5
```

Subclass `BaseAgent` (external — drives the env via `exec`) or `BaseInstalledAgent` (installed into the container, run headless). `BaseAgent` (`src/harbor/agents/base.py`):

```python
@staticmethod
@abstractmethod
def name() -> str: ...
@abstractmethod
def version(self) -> str | None: ...
@abstractmethod
async def setup(self, environment: BaseEnvironment) -> None: ...
@abstractmethod
async def run(self, instruction: str, environment: BaseEnvironment,
              context: AgentContext) -> None: ...
```

Class vars: `SUPPORTS_ATIF`, `SUPPORTS_RESUME`, `SUPPORTS_CONFIG`, `SUPPORTS_WINDOWS`. `BaseInstalledAgent` adds `install()` (via `exec_as_root`/`exec_as_agent`) and `populate_context_post_run()`.

**Working precedent:** `github.com/badlogic/pi-terminal-bench` — a third-party adapter run as `--agent-import-path pi_terminal_bench:PiAgent`. Confirms the flow works from outside the org. (It also documents a needed `upload_dir` patch when the agent creates a `/tests` dir — a real gotcha.)

Other plumbing: `--ak/--agent-kwarg k=v` (constructor kwargs), `--ae/--agent-env` (arbitrary env vars into the agent — this is how you'd inject `ANTHROPIC_BASE_URL` or credentials).

**⚠ Hard requirement:** CI verifies *every rewarded trial has a Hub `trajectory_path` (ATIF)* so the reward-hacking judge can audit it. **Our agent must set `SUPPORTS_ATIF = True` and emit ATIF trajectories, or the submission fails static analysis.**

> ✅ **ALREADY SATISFIED — do not build an emitter (verified 2026-08-05).** This requirement was
> written against the D-D/D-E plan of shipping our *own* agent adapter. The D-G architecture runs
> `-a claude-code`, harbor's **built-in** adapter, which sets `SUPPORTS_ATIF = True` at
> `harbor/agents/installed/claude_code.py:33` and converts Claude Code sessions to ATIF in
> `_convert_events_to_trajectory` (`:708`). Measured over the sweep's own job dirs: **126
> `agent/trajectory.json` files, 0 unparseable, 0 zero-step, `schema_version = "ATIF-v1.7"`.**
> TB-6's acceptance therefore becomes *validate the emitted files*, not *write an emitter* — and
> the honest correction is that a session that "found no ATIF support" had grepped our own
> `benchmark/terminal-bench-2.1/` directory, where there is correctly nothing to find.
>
> **Upload is likewise a flag, not a build:** `harbor run --upload` with `--public/--private`.
> Wired as `TB_UPLOAD` in `run-dg.sh`, failing closed — unset/`0` uploads nothing, `1` uploads
> **private** (exercise the flow, nothing indexed), and only the literal string `public` uploads
> publicly. Any other value **refuses rather than guessing**, because every plausible typo
> (`true`, `yes`, `PUBLIC`) guessing in the permissive direction is an irreversible publish under
> R1. Guarded by `benchmark/terminal-bench/upload-gate.test.sh` (10 assertions; verified to fail
> on the pre-change tree, so it is not a tautology).
>
> **What remains genuinely blocking for a submission:** `k >= 5` (R9 auto-rejects `<5` trials),
> the TB-11 trajectory self-audit before any public upload, and R4's `.terransoul/` container-state
> check.

---

### 3. ⚠ DECISIVE — local / OpenAI-compatible models: **YES, supported**

Harbor calls models through **LiteLLM** ("uses LiteLLM to call 100+ LLM providers"). `LiteLLM.__init__` takes `model_name`, `temperature`, and **`api_base` — documented as "Override the API base URL (useful for local or proxy endpoints)"**, which "allows routing requests to a local LLM proxy or an alternative API endpoint without changing any other code."

Confirmed working configuration (AISBench runbook, Terminus 2 against a local vLLM server):

```python
model_names=["hosted_vllm/qwen3"],
agent_kwargs={
    "api_base": "http://0.0.0.0:8080/v1",
    "model_info": {"max_input_tokens": 128000, "max_output_tokens": 4096,
                   "input_cost_per_token": 0.0, "output_cost_per_token": 0.0},
}
```

CLI equivalent: `--agent-kwarg api_base=http://…/v1` alongside `-m hosted_vllm/<model>` (or `ollama_chat/<model>` with `api_base: http://…:11434`).

**Requirements and caveats:**
- Endpoint must implement OpenAI `chat/completions` **with tool-call support**; `api_base` is the root, `/chat/completions` is appended.
- Container→host networking: use `network_mode: host` in docker-compose so the sandbox can reach a host-side inference server.
- `input_cost_per_token: 0.0` is how you get truthful $0 cost accounting for a local model.
- **This applies to `BaseAgent`-style agents that call LiteLLM (Terminus 2, and our agent).** It does *not* automatically apply to `BaseInstalledAgent` wrappers of vendor CLIs — Claude Code would need `ANTHROPIC_BASE_URL` via `--agent-env` instead. Since we're writing our own agent, we control this end-to-end.

**→ The "first fully-local entry" submission is mechanically possible.**

---

### 4. Submission mechanics

```bash
harbor run -d terminal-bench/terminal-bench-2-1 -a <agent> -m <provider/model> \
  --ak reasoning_effort=<effort> -e <sandbox> -k 5 -n <concurrency> --upload --public
# then:
cd leaderboard && uv run lb submit https://hub.harborframework.com/jobs/<uuid>
# → opens PR → CI validates → maintainers review trajectories → merge = leaderboard row
```

`-k` = **trials per task** (≥ 5 required), *not* task count. `lb submit` runs filter → metadata → open-prs.

**CI static analysis rejects:** missing/null metadata, wrong timeout/resource config, incomplete task coverage, insufficient trials, any rewarded trial lacking an ATIF `trajectory_path`, per-trial records not matching job config.

**Then an LLM trajectory judge audits successful trials** for *harness cheating, reward hacking, refusals, missing trajectories* — before metrics are finalized. This is not theoretical: the Opus 4.7 submission has `"disqualified_trials": [{"reason": "reward_hacking", ...}]` ×2 and publishes `reward_hacks: 0.45` as a **"Hacks" column on the public leaderboard**. This is the mechanism that would catch every item on your out-of-scope list, and it is publicly displayed. Your ⛔ constraints are also simply the winning strategy here.

**What becomes public:** the job and **all trials must be publicly readable** on Harbor Hub — including full ATIF trajectories (that's what the judge and maintainers read). The submission JSON in the repo publishes `accuracy`, `accuracy_stderr`, `n_trials`, `pass_at_2..5`, uncached/cached input + output token counts, `total_cost_usd`, `avg_trial_duration_sec`, `reward_hacks`, every trial UUID, and the PR URL. **Agent source code is not required to be public** — no openness rule appears in SUBMIT.md (pi-terminal-bench is open by choice).

**⚠ Open question to resolve before committing:** the leaderboard carries the note *"A Terminal-Bench team member ran the evaluation and verified the results."* SUBMIT.md documents a self-run flow with no such requirement, and the schema has no `verified` flag — so this is likely a per-entry provenance note, not a gate. **Worth confirming with maintainers before spending the compute budget**, since it determines whether our self-run numbers are authoritative or get re-run.

---

### 5. Cost for one valid submission

**Volume:** 89 tasks × 5 trials = **445 trials** (one board entry shows 447). From the published Opus 4.7 token breakdown ÷ 447 trials: ~71K uncached input, ~1.80M cache-read input, ~33K output **per trial**. Given cumulative cache reads of 1.8M against a prefix in the tens of thousands of tokens, that implies roughly **30–50 model calls per trial → ~15,000–22,000 model calls per submission run.**

**Empirical anchors (published, full 5-trial runs):**

| Entry | Accuracy | Cost |
|---|---|---|
| Claude Code + Opus 4.8 ← **our target** | 78.9% | **$286.94** |
| Claude Code + Opus 4.7 max | 68.9% | $599.52 |
| Terminus 2 + Opus 4.7 | 66.1% | $582.26 |
| Cursor CLI + Grok 4.5 (cheapest) | 79.3% | $134.09 |
| Codex + GPT-5.5 (most expensive) | 83.1% | $2,059.19 |

**Assumptions, stated explicitly:**
- Opus 4.8 list price: **$5.00/M input, $25.00/M output**; cache reads ~0.1× input ($0.50/M), cache writes 1.25× ($6.25/M).
- ⚠ **Caveat:** recomputing the published Opus 4.7 token counts at list price gives ~$935 (159 + 403 + 372), but the board reports $599.52 — the board's accounting is ~36% below naive list price. I could not reconcile this from public data; likely the `cached_input_tokens` bucket mixes writes and reads, or a blended rate is used. **Treat the board's $286.94 as the reliable anchor, not my recompute.**
- Opus 4.8 is ~2× cheaper than 4.7 on this benchmark at identical list pricing — it solves more tasks in fewer turns.

**Estimate for a TerranSoul-agent + Opus 4.8 run:**

| Line item | Estimate |
|---|---|
| Baseline (Claude Code parity, 445 trials @ $0.645/trial) | ~$290 |
| Our scaffold overhead (memory retrieval + self-verification passes, 1.5–2.5×) | **$430–$720 per full run** |
| Dev/debug on task subsets (`-l N`) + 2–4 aborted or below-par full runs | $600–$2,500 |
| **Total realistic campaign budget** | **$1,500–$3,500** |

**Wall clock:** 445 × ~800 s ≈ **99 compute-hours**; at `-n 32` on Daytona ≈ 3–4 h per run (tail-limited by long tasks). Sandbox compute (`DAYTONA_API_KEY`) is **billed separately from model tokens** and is not in the board's cost column — unpriced in this recon.

**Local gemma4:12b submission (separate claim):** model cost **$0** (set `input_cost_per_token: 0.0`), but ~99 serialized GPU-hours on one local card — realistically **4–10 days** of continuous run. Be honest in planning: the board's floor is 58.7% (GLM-5.1, a large frontier-class open model); a 12B local model should be expected in the single digits to low teens. The claim there is *"first fully-local entry"*, not rank — which is exactly how you framed it.

---

### Recommended next steps (RECON B scope)

1. **Confirm the "team member verified" note** with maintainers — it's the one unresolved gate.
2. **Clone `badlogic/pi-terminal-bench`** as the reference scaffold; it is the shortest path to a working `--agent-import-path` adapter, including the `upload_dir` patch.
3. **Design ATIF trajectory emission first** — it's a hard CI requirement, not a nice-to-have, and it's what maintainers read.
4. Smoke-test with `-a oracle -l 5` to validate the harness before writing any agent code.

**Sources:** [TB 2.1 leaderboard](https://www.tbench.ai/leaderboard/terminal-bench/2.1) · [terminal-bench-2-1 repo](https://github.com/harbor-framework/terminal-bench-2-1) · [SUBMIT.md](https://raw.githubusercontent.com/harbor-framework/terminal-bench-2-1/main/leaderboard/SUBMIT.md) · [Opus 4.7 submission JSON](https://raw.githubusercontent.com/harbor-framework/terminal-bench-2-1/main/leaderboard/submissions/2026-05-01-anthropic-claude-opus-4-7-max-claude-code.json) · [Harbor Agents docs](https://www.harborframework.com/docs/agents) · [Harbor Task Structure](https://www.harborframework.com/docs/tasks) · [Terminus-2 docs](https://www.harborframework.com/docs/agents/terminus-2) · [LiteLLM integration (DeepWiki)](https://deepwiki.com/harbor-framework/terminal-bench/4.4-llm-integration-(litellm)) · [AISBench local-inference runbook](https://ais-bench-benchmark.readthedocs.io/en/latest/extended_benchmark/agent/harbor_bench.html) · [pi-terminal-bench](https://github.com/badlogic/pi-terminal-bench) · [Terminal-Bench paper (arXiv 2601.11868)](https://arxiv.org/html/2601.11868v1) · [TB 2.1 Hub dataset card](https://hub.harborframework.com/datasets/terminal-bench/terminal-bench-2-1/6)

---

## 3. RECON B — what the winning scaffolds do

Recon complete. All source read directly; no repo files touched.

## RECON B — What the winning Terminal-Bench scaffolds actually do

### 0. Board reality check (verified 2026-08-02)

TB **2.1** = 17 entries, all vendor CLIs + Terminus 2 + mini-SWE-agent. **Zero third-party harnesses.** TB **2.0** = **142 entries**, ~20 of them third-party harnesses. Custom agents are first-class on both (`harbor run --agent path.to.agent:MyAgent`).

Same-model, cross-scaffold pairs — this is the only clean measurement of what a scaffold is worth:

| Model | Best scaffold | Worst scaffold | Spread |
|---|---|---|---|
| Opus 4.6 (2.0) | Meta-Harness 76.4±2.4 | Claude Code 58.0±2.9 | **18.4 pp** |
| GPT-5.5 (2.0) | NexAU-AHE 84.7±2.1 | clnkr 66.1±2.5 | **18.6 pp** |
| GPT-5.3-Codex (2.0) | SageAgent 78.4±2.2 | Terminus 2 64.7±2.7 | **13.7 pp** |
| Opus 4.5 (2.0) | Droid 63.1±2.7 | Claude Code 52.1±2.5 | **11.0 pp** |
| Fable 5 (2.1) | Claude Code 83.8±1.2 | Terminus 2 80.4±1.2 | 3.4 pp |
| Opus 4.7 (2.1) | Claude Code 68.9±1.4 | Terminus 2 66.1±1.4 | 2.8 pp |

Two caveats that matter for our claim: (a) Claude Code's 2.0 rows look like default-config runs — on 2.1 it is the strongest scaffold on the board, so **we are targeting the best scaffold, not the median**; (b) **no Terminus 2 + Opus 4.8 row exists anywhere** — we must run that ourselves as the neutral control.

---

### 1. Terminus 2 — the actual loop
Source: `terminal_bench/agents/terminus_2/terminus_2.py` (620 lines), `prompt-templates/terminus-json-plain.txt`.

- **Mono-tool**: one live tmux session. LLM emits `{keystrokes, duration}` **batches**, not one action.
- **No structured outputs** — deliberately. Invalid JSON is retried with a warning appended.
- **Done = two-phase**: `task_complete:true` triggers "Are you sure? …you won't be able to make any further corrections", and only a *second* consecutive confirm exits. Any non-complete response resets `_pending_completion`.
- **Output cap 10 000 bytes**, head/tail halves, middle elided with a byte count.
- **Context**: proactive summarize when `free_tokens < 8000`; reactive on `ContextLengthExceededError` → unwind message *pairs* to 4 000 free, then a **3-call handoff ritual**: summarize → next-agent asks ≥5 questions → previous agent answers → history collapsed to `[system, questions, answers]`.
- **Retry**: `@retry(stop_after_attempt(3))`; on output-overflow it *salvages* the truncated response (XML only) or recurses with an explicit "NONE of your actions were performed" message.
- Duration clamped to 60 s; `max_episodes` effectively unlimited (1 000 000); temp 0.7.

### 2. mini-SWE-agent — the minimum that works
Source: `agents/default.py` (~190 lines), `config/default.yaml`.

Bash-only, **no tool-calling API** (runs on any model), **stateless subshell per action** ("directory or env changes are not persistent"), **strictly linear history** (trajectory ≡ messages), exactly one action per turn, done = `echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT`. Limits: `step_limit`, `cost_limit` (3.0 default), `wall_time_limit_seconds`, `max_consecutive_format_errors: 3`. Observation template truncates >10 000 chars into head 5 000 + elided count + tail 5 000, and *tells the model how to re-query smaller*. Env sets `PAGER: cat`, `TQDM_DISABLE: 1` etc.

**It scores 76.2±1.2 on TB 2.1 (8th/17) — above Claude Code + Opus 4.7 (68.9).** This is the strongest available evidence that elaborate scaffolding is not required to be competitive.

---

### 3. RANKED scaffold techniques by evidence

**Tier 1 — [MEASURED], isolated ablation**

1. **Reasoning-effort scheduling ("reasoning sandwich")** — high effort on plan + verify, medium on implement. LangChain, gpt-5.2-codex, TB 2.0: flat-xhigh **53.9%**, flat-high **63.6%**, sandwich **66.5%**. → **+2.9 pp** over best flat, and flat-max is **−9.7 pp** because of timeouts. Cleanest isolated number in the whole corpus.
2. **Environment bootstrap** — inject a pre-loop snapshot (cwd, `/app` listing ≤20 entries, language versions, package managers, free memory; 15 s timeout, silent failure) into the *first* prompt. Meta-Harness (Stanford IRIS), Opus 4.6, 89×5: **74.7 → 76.4 = +1.7 pp**. Notably it was the **only net-positive edit out of 10 automated search iterations**.
3. **Proactive selective memory injection** — arXiv 2607.08716. TB 2.0: Sonnet 4.5 37.6 → 45.9 (**+8.3 pp**); **Opus 4.6 43.5 → 45.9 (+2.4 pp)**. Real ablation (τ²-Bench macro, Sonnet 4.5): full two-phase **64.3** > always-inject 63.5 > full-bank-in-context 61.5 > Mem0-style retrieval 62.1 > injection-only-no-bank 61.0 > baseline 57.5. Architecture: a *separate* memory agent on a fixed interval, private status field + knowledge memories + procedural memories (failed commands, successful fixes), and **choosing silence is an explicit action**. Failure mode named: **"behavioral state decay."**

**Tier 2 — [MEASURED] as a bundle; per-technique attribution is [CLAIMED]**

4. **The Terminus-KIRA bundle — biggest same-model delta on the board.** Opus 4.6: Terminus 2 62.9±2.7 → **Terminus-KIRA 74.7±2.6 = +11.8 pp**; Gemini 3.1 Pro: Gemini CLI 61.4±4.1 → KIRA 74.8±2.6 = +13.4 pp. Authors claim "~10 pp on frontier models." Five changes shipped together, so individually [CLAIMED]:
   - anti-premature-submission framing ("only one submission… the submission is FINAL");
   - `"You must complete the entire task without any human intervention"`;
   - `"You do NOT have eyes or ears, so you MUST resort to programmatic/AI tools"` + a dedicated multimedia-read tool (tmux can't carry images);
   - **multi-perspective completion checklist** — the confirm prompt re-states the original task and forces TODO/DONE against *test engineer / QA engineer / requesting user*, plus a robustness check and a "minimal state changes — leave nothing else altered" audit;
   - **pull-based tmux** (marker `__CMDEND__`, `BLOCK_TIMEOUT_SEC = 600`) replacing "guess a duration and sleep", plus **output cap 10 000 → 30 000 bytes**, and native tool calling replacing in-context JSON parsing.
5. **Build → self-verify → fix loop with a pre-completion interceptor.** LangChain deepagents, gpt-5.2-codex, TB 2.0: **52.8 → 66.5 = +13.7 pp, harness-only, model fixed.** Named "primary driver" but not isolated. Stated root failure: *"the agent wrote a solution, confirmed it looks ok, and stopped."* Bundle also included local-context middleware and loop-detection (per-file edit counters → inject "reconsider your approach").
6. **Automated, trace-driven harness evolution.** NexAU-AHE: GPT-5.4 **69.7 → 77.0 over 10 iterations (+7.3 pp)**; final **84.7±2.1** with GPT-5.5 vs Codex CLI 82.2. Seven git-tracked orthogonal components (systemprompt, agent config, tool_descriptions, tools, middleware, skills, sub_agents+long-term memory). Frozen harness transfers to SWE-bench-Verified.
7. **Self-Harness** (model-specific harness edits): MiniMax M2.5 40.5 → 61.9, GLM-5 42.9 → 57.1, Qwen3.5-35B-A3B 23.8 → 38.1. All **+14 to +21 pp — but all on weak/open models.**

**Tier 3 — [MEASURED] NEGATIVE (what not to do)**

8. Flat maximum reasoning effort: **−9.7 pp**, lost to timeouts.
9. **Rewriting prompts or control flow regresses.** Meta-Harness: template edits **−5.6 to −6.7 pp**; marker-stripping/loop-breaker **−1.1 pp** isolated; verification-flow edits created *infinite checklist cycles*; cleanup directives made agents delete state they still needed. Six consecutive failed iterations before the proposer abandoned control-flow edits and pivoted to **purely additive** changes.
10. Always-on injection and full-bank-in-context both lose to *selective* injection.

---

### 4. Submission mechanics (hard constraints on any plan)

From `leaderboard/SUBMIT.md` + `docs/agents/index.mdx`:
- **All 89 tasks × ≥5 trials.** Errored trials count `reward 0`. `timeout_multiplier` must be unset or `1.0`; **no agent/verifier timeout or resource overrides** — CI rejects. Minimum **445 trials per submission**.
- **Every rewarded trial must carry an ATIF trajectory** (`trajectory_path` on the Harbor hub) — *"agents that only upload custom logs fail here."* Non-negotiable engineering item.
- Flow: `harbor run --upload --public` → `lb filter` → `lb metadata` → `lb open-prs` → static analysis → bot PR → maintainer `/judge` → `/apply` → merge.
- `/judge` is an LLM reviewing **every successful trajectory**, bucketing into **Harness cheating 🔴 (invalidates the submission)** and **Reward hacking 🟡**.

### 5. Out-of-scope techniques encountered — reported, not used

Harbor ships `examples/configs/agents/openhands-**cheating**-agent-job.yaml` as a deliberate canary, and there is a public literature on gaming these boards (*BenchJack*, arXiv 2605.12673, "systematically auditing AI agent benchmarks"). I did not open, analyse, or build on either. Everything ranked above is generic harness engineering that keeps its value if the task text changes.

---

### 6. Implications for the target claim

**The honest problem:** every large scaffold win above was measured *against a weak baseline* (Terminus 2, or a stripped deepagents), never against Claude Code — which is the **strongest** scaffold on the 2.1 board. And the technique closest to TerranSoul's thesis (a memory layer) **decays 3.5× as the model gets stronger: +8.3 pp on Sonnet 4.5 → +2.4 pp on Opus 4.6.** Extrapolated to Opus 4.8, a pure memory layer projects to roughly **+1 to +2.5 pp — inside the ±1.3 error bar.** Beating 78.9±1.3 needs ≈+2.6 to clear 2 SE. So a memory layer *alone* is not a credible route to the headline claim; it has to be carried by the Tier-1/Tier-2 harness stack (verification checklist, anti-premature-submission, reasoning scheduling, env bootstrap, pull-based execution).

**Where the memory/reasoning thesis is strongest:** Self-Harness (+14 to +21 pp) and the memory paper (+8.3 pp) both peak on weak/open models. The **local gemma4:12b submission is where TerranSoul's differentiator has real headroom** — and it would be the board's first fully-local entry regardless of rank.

**Recommended shape:**
1. Build a `BaseAgent` subclass with ATIF emission from day one (blocking requirement).
2. Start from Terminus 2 + the KIRA bundle *faithfully vendored* (repo policy: copy, don't reimplement) — that is a board-verified +11.8 pp floor. Artifacts: `krafton-ai/kira`, `stanford-iris-lab/meta-harness-tbench2-artifact` (`agent.py`, `prompt-templates/terminus-kira.txt`).
3. Layer only **additive** context (env bootstrap, selective memory injection, loop detection). Meta-Harness's six consecutive failures say do **not** rewrite the loop or the base prompt.
4. Adopt reasoning-effort scheduling — the cheapest isolated +2.9 pp, and it protects against the −9.7 pp timeout trap.
5. Run **Terminus 2 + Opus 4.8** ourselves as the missing control, so the claim is "same model, three scaffolds" rather than a single cross-vendor comparison.
6. Budget: ≥445 trials per arm; with a control arm that is ≥890 trials before any tuning iteration.

Downloaded sources for reference: `C:\Users\DevStar\AppData\Local\Temp\claude\D--Git-TerranSoulApp\5d5a8a67-dbb7-472a-9c6e-229b8009ba83\scratchpad\recon\` (terminus_2.py, terminus-json-plain.txt, mini-default.py, mini-default.yaml, mh-agent.py, terminus-kira.txt, SUBMIT.md, kira.txt, harbor base.py, trajectory-format.mdx).

**Sources:** [TB 2.1 leaderboard](https://www.tbench.ai/leaderboard/terminal-bench/2.1) · [TB 2.0 leaderboard](https://www.tbench.ai/leaderboard/terminal-bench/2.0) · [Terminus 2 source](https://github.com/laude-institute/terminal-bench/tree/main/terminal_bench/agents/terminus_2) · [mini-SWE-agent](https://github.com/SWE-agent/mini-swe-agent) · [Terminus-KIRA writeup](https://www.krafton.ai/blog/posts/2026-02-20-terminus_kira/terminus-en.html) · [Meta-Harness artifact](https://github.com/stanford-iris-lab/meta-harness-tbench2-artifact) · [Meta-Harness paper](https://arxiv.org/html/2603.28052v1) · [LangChain harness engineering](https://www.langchain.com/blog/improving-deep-agents-with-harness-engineering) · [NexAU-AHE](https://github.com/china-qijizhifeng/agentic-harness-engineering) · [Proactive Memory Agent](https://arxiv.org/abs/2607.08716) · [Self-Harness](https://arxiv.org/abs/2606.09498) · [Harness-Bench](https://arxiv.org/abs/2605.27922) · [Harbor agents docs](https://www.harborframework.com/docs/agents) · [SUBMIT.md](https://github.com/harbor-framework/terminal-bench-2-1)

---

## 4. RECON C — how agents lose points (model-bound vs harness-bound)

## RECON C — HOW AGENTS LOSE POINTS ON TERMINAL-BENCH

No files changed, no cargo, no bench. Web research only.

---

## 0. The number that decides the whole project

Harness effect at **fixed model**, measured on the live board and in TB's own papers:

| Model | Harness A | Harness B | Δ |
|---|---|---|---|
| Gemini 3 Pro | Terminus 2 73.9% | Gemini CLI 65.8% | **+8.1** |
| Sonnet 4.5 (TB2.0 paper) | Terminus 2 | Claude Code | **+5.4** |
| GPT-5.5 | Codex 83.1% | Terminus 2 78.0% | **+5.1** |
| Fable 5 | Claude Code 83.8% | Terminus 2 80.4% | **+3.4** |
| Opus 4.7 | Claude Code 68.9% | Terminus 2 66.1% | **+2.8** |
| Gemini 3.1 Pro | Gemini CLI 65.8% | Terminus 2 65.6% | **+0.2** |

Median ≈ +3.4 pp, range +0.2 → +8.1. **The scaffold is worth ~1–2 leaderboard ranks and the target margin (+2.8 pp over Claude Code + Opus 4.8) sits at the median of what scaffolds already demonstrably move.** The goal is not exotic. Note the Gemini row: a *generic* 300-line harness beats the vendor's own CLI by 8 pp — vendor scaffolds are not a ceiling.

**Counter-evidence that must be stated up front.** "Rethinking the Evaluation of Harness Evolution" reports that automatically evolved harnesses gain large amounts on their training tasks but collapse to **+0.6 pp on held-out tasks**, concluding "most edits memorize fixes rather than distilling strategies" and even "Terminal-Bench may simply not be very sensitive to harness design."

The resolution matters for our design: the +0.6 result is about *auto-evolved, task-shaped patches* measured on held-out tasks; the +2.8…+8.1 deltas above are *hand-designed general scaffolds* measured on the real board. So the evidence says: **generic mechanisms transfer, task-shaped patches do not.** That is an empirical argument for exactly the discipline `rules/bench-agi-purity.md` already mandates — and it means any TerranSoul mechanism must be justified without reference to any specific task.

---

## 1. The failure taxonomy, with model/harness attribution

Attribution is mine, grounded in the cited source; I flag where the source itself attributes.

### Tier A — harness-fixable, points on the table

| # | Failure | Evidence | Why harness-fixable |
|---|---|---|---|
| A1 | **Infrastructure errors** — tmux race condition (keystrokes sent before session init), container startup timeout, agent install failure | **2.5–5.5%** of attempts (TB paper); **3–21.5%** (TerminalWorld) | Pure scaffold bug. And **"errored trials count as reward 0 — they are not excluded from the metric"** (SUBMIT.md). This is 2–5 pp of free score lost to a race condition. Deterministic startup handshake + retry-on-init fixes it outright. |
| A2 | **Context overflow → summarization → re-proposing already-failed solutions.** Agent "loses fine-grained memory of its prior actions, leading to confidently proposed 'new' solutions that are logically identical to previously failed attempts" | Terminal-World; MAST **FM-1.4 Loss of Conversation History**, 24% in GPT-OSS-120B vs **0%** in Gemini-3-Flash — classified *fatal* | The 0%-vs-24% spread on the same taxonomy proves this is a *context-management* property, not an intelligence property. MAST's own prescription: "aggressive context hygiene." |
| A3 | **Step repetition / redundant exploration** — re-listing dirs, re-reading files, re-running known-failing commands | MAST **FM-1.3: 90%+ even in *successful* runs**; TerminalWorld "efficiency paradox": failed attempts burn **3.3× the tokens** of successful ones, and 43% of attempts consume 63% of cost | Not directly fatal, but it is the *fuel line* to A5 (timeout). Compression work shows 18–57% token savings; MRAgent 118k vs A-Mem 632k prompt tokens; TraceRetain cut environment steps **37–55%**. |
| A4 | **Execution deadlock** — agent correctly *identifies* it is stuck in an interactive prompt but "fails to adapt its recovery strategy" | Terminal-World | The diagnosis is right, the recovery is missing. That is a retry-policy/escalation-ladder gap in the scaffold, not a reasoning gap. Textbook harness fix. |
| A5 | **Budget blindness / timeout-driven incomplete progress** — **the single largest bucket** | **79% of unresolved runs (518/660)** on LHTB; 62.8% of runs land in partial credit 0.05<R<0.95 | Source attributes to model ("cannot budget a long horizon"). **I dispute the attribution:** the model cannot budget what it cannot see. LemonHarness's named contribution is a "time-aware mechanism exposing elapsed and remaining budget to the model"; harness-evolution lists "turn budget trackers that remind the agent to ship output once thresholds are reached." Making the clock an observable is a harness act. Residual after that is model. |
| A6 | **Unaware of termination conditions** | MAST FM-1.5, *fatal*, +46% spike in Kimi-K2 | MAST prescribes "implement Finite State Machines" — an explicit scaffold fix. |
| A7 | **Missing executables** — calling binaries not installed / not in PATH | **24.1% of all command-level errors** — the largest single command error class | Cheap harness fix: probe-before-invoke, cache the environment's capability set once, never re-discover. Also the clearest case where within-episode memory pays immediately. |

### Tier B — mixed; harness converts a fatal into a recoverable

| # | Failure | Evidence | Split |
|---|---|---|---|
| B1 | **Premature termination / false finish** — stops with substantial reward but hidden verifier unsatisfied | MAST FM-3.1 *fatal*; LHTB: early exits **19% of unresolved runs**, 14 runs died at R≥0.75 | The *decision* to stop is model. The *permission* to stop is harness. MAST: "Externalize Verification… **require hard tool evidence before exit**." An exit gate that refuses "done" without a passing self-authored check converts most of this. Strongest single ROI on the board after A1. |
| B2 | **Incorrect / weak verification** — agent verifies, but verifies the wrong thing | MAST FM-3.3: **+52% in failed frontier traces**, "fatal for frontier models"; TB paper subtypes "No or Irrelevant Verification" / "Weak Verification" | Harness can *force* a verification step; whether the check is the right check is model judgment. LHTB: agents "systematically overestimate completion and under-invest in final verification," and after obvious errors are fixed must hunt residual defects "with no visible signal." Partial win only. |
| B3 | **cwd / state loss** | Not isolated as a named category in any source I found — subsumed under coherence/context loss | Harness-fixable (inject cwd + mutation ledger every turn) but the sizing is **unmeasured**. Do not build a thesis on it. |

### Tier C — model-bound; scaffold will not save us

| # | Failure | Evidence |
|---|---|---|
| C1 | **Reasoning–action mismatch** — states one plan, executes another | MAST FM-2.6: **92% Kimi-K2, 94% GPT-OSS-120B**, "often fatal." Highest-prevalence mode found, and it is squarely inside the model. |
| C2 | **Deep domain reasoning** | Harness-evolution: "the stable core of hard failures, which stem from deep domain reasoning demands or constraints outside harness control, **remains unaffected by accumulated knowledge**." |
| C3 | **Execution errors as the dominant frontier profile** | TB paper: frontier models (Opus 4.5, GPT-5.2) show *execution*-heavy failure profiles; open-source (Qwen Coder) spread evenly across execution/coherence/verification. Command error rate 9.2% (Grok 4) → 26.7% (GPT-OSS-120B). **Implication for the secondary local-gemma4 submission: a small model fails differently — it needs coherence and verification support, not just efficiency. Do not reuse the Opus-tuned scaffold unchanged.** |
| C4 | **Task derailment** | MAST FM-2.3: 25% of Kimi-K2 failures, fatal when present. |

---

## 2. Honest assessment of the memory thesis

**Where episode memory genuinely wins (defensible):**

- **A2 is a direct, documented hit.** The Terminal-World description of the failure — summarize, lose action history, re-propose an identical failed solution "confidently" — is a verbatim description of what a durable within-episode action ledger prevents. This is the strongest single piece of external support for TerranSoul's thesis on this benchmark.
- **A3/A7 are the volume play.** "Already tried this and it failed", "this path does not exist", "this binary is not installed" are exactly the facts being re-derived. Measured analogues: 37–55% fewer environment steps, 18–57% token savings, 5.4× prompt-token reduction.
- **A3 → A5 is the causal chain that makes it a *score* win, not just a cost win.** The #1 failure bucket is running out of clock (79%), and failed runs burn 3.3× the tokens. Memory does not make the model smarter; it **returns budget to the part of the horizon where the task is actually solved.** That is the mechanism to state in the writeup, and it is falsifiable: if we cut tokens/steps but pass-rate does not move, the thesis is wrong.

**Where memory will NOT help — state these before a reviewer does:**

- **C1 reasoning–action mismatch (92–94%).** Memory cannot fix a model that says A and does B. Untouched.
- **C2 deep domain reasoning.** Explicitly "unaffected by accumulated knowledge."
- **B1 premature termination.** Knowing what you tried ≠ knowing you are done. This needs an **exit gate**, a different mechanism. Do not sell it as a memory win.
- **B2 verification correctness.** Memory can enforce *that* you check; it cannot make the check correct.
- **Memory has its own failure mode.** Under 75% failed-distractor pollution, unbounded memory precision fell 20.2% → 12.4%, and insertion-order eviction collapsed to 3.8%. "Failed trajectories can be retrieved for new tasks." An episode ledger dominated by dead ends is an *attractive nuisance* — we must retrieve failed attempts as **negative constraints on the current subgoal only**, never as candidate plans.
- **Diminishing returns when the benchmark is easy for the model.** TraceRetain: memory gives "no clear advantage on clean saturated benchmarks." TB 2.1 at ~79% is *partly* saturated for Opus 4.8 — expect gains concentrated in the hard tail, not uniformly.
- **The literature gap is real and cuts both ways.** TraceRetain explicitly does **not** address intra-episode tracking of abandoned strategies — its memories are post-hoc episode summaries. MSCE requires evidence from ≥n_min *distinct episodes* before inducing a policy. **Nobody in the surveyed work has properly built the within-episode failed-approach ledger.** That is a genuine novelty claim for TerranSoul — and simultaneously means we have **no external prior that it works**. Treat it as the hypothesis under test, not as settled.

**Load-bearing warning on cross-episode memory:** MSCE's headline gains (+15.39 SE, monotonic improvement p0→p100) come from *learning across tasks*. On an 89-task benchmark with 5 trials each, cross-task memory that persists between tasks is (a) indistinguishable from test-set learning to a maintainer reading trajectories, and (b) in violation of `rules/bench-agi-purity.md`. **Recommendation: memory scoped strictly within a single task episode, reset between tasks, and say so explicitly in the submission.** We give up the biggest published gains to keep the claim clean. That is the right trade.

---

## 3. Variance — what score difference is actually meaningful

**Submission rules (github.com/harbor-framework/terminal-bench-2-1, `leaderboard/SUBMIT.md`):**
- ≥5 trials per task, all 89 tasks, dataset version pinned in `core/hub.py`
- **No timeout overrides, no resource overrides, `timeout_multiplier` unset or 1.0**
- **Errored trials count as reward 0 — not excluded**
- Trials publicly readable on Harbor Hub; every passing trial needs a Hub `trajectory_path`
- CI stamps accuracy ± SE, pass@k, tokens, cost, avg duration, reward-hacking %
- Merge requires maintainer review via `/judge`

**Noise, quantified:**
- Leaderboard SE: **±1.1 to ±1.7 pp** (pooled over 89 × 5 = 445 trials)
- **LemonHarness ran 5 jobs on TB 2.0 and got 80.90% → 89.89% — a 9-point spread**, attributed to "model sampling, task-path choices, and model-interface stability"
- These agree with binomial expectation: one 89-task pass at p≈0.79 has SE ≈ **3.8 pp**; pooling 5 gives ≈1.7 pp

**Consequences — the most operationally important findings in this report:**

1. **A single 89-task run is worthless for decision-making.** SE ≈ 3.8 pp means one run can move ±7 pp for free. Any internal A/B on one pass will produce confident garbage. Never tune on a single run; this is the same lesson as `reference_bench_cross_system_contamination.md`.
2. **To beat 78.9% ± 1.3% we need roughly +3.5 pp, i.e. ≈ 82.4%.** SE of the difference is √(1.3² + our_SE²) ≈ 1.8 with 5 trials, so 95% significance needs ~3.6 pp. Their SE is fixed at 1.3, so even with *infinite* trials on our side the floor is ~2.6 pp. **The stated +2.8 pp target is only ~1.5σ — it would be a nominal win that a competent reviewer could call noise.** Set the internal bar at **82.5%+**, not 79%.
3. **Run more than 5 trials.** 15 trials cuts our SE to ~0.75 and the required margin to ~2.9 pp. Cheap insurance; the rules say *at least* 5.
4. **A1 is worth 2–5 pp of pure arithmetic** because errored trials score 0. Before any cleverness, make startup deterministic. This alone could be most of the required margin.

---

## 4. Integrity landscape — reported, not adopted

Per the out-of-scope instruction: these techniques exist in the wild; **we are not using any of them.**

- **Confirmed cheating, submissions removed:** *OpenBlock (OB-1)* modified timeouts and "stored encrypted solutions in their agent binary"; *QuantFlow* uploaded the test folder as part of agent setup.
- **Confirmed reward hacking:** *ForgeCode*'s agent "retrieved solutions from the internet and included them in documentation files across multiple trials."
- **Structural exposure:** *Terminal Wrench* published 331 reward-hackable environments and 3,632 exploit trajectories; **13 of 89 TB 2.0 environments (15%) are demonstrably hackable.**
- **Current enforcement:** ATIF trajectories required for all passing trials; maintainers run an **agent judge over every passing trial**; reward hacking zeroes the trial; cheating = immediate takedown. The judge is being open-sourced so submitters can self-check.

Two actionable implications, both defensive:
- **ForgeCode's failure was arguably not intentional in design — network access was the vector.** Our agent must run with no ability to fetch solutions, and we should say so. Since 15% of environments are hackable, **a strong agent can reward-hack by accident**; we should run the open-sourced judge over our own passing trials before submitting and be prepared to discuss anything it flags.
- `--upload --public` + full trajectories means **every design decision is publicly readable.** Anything task-shaped will be seen. This is a hard external enforcement of `rules/bench-agi-purity.md`, not merely an internal rule.

---

## 5. What this implies for the plan (ranked by evidence strength × measurability)

1. **Deterministic environment/session startup with retry** — kills A1. Worth 2–5 pp arithmetically because errored trials score 0. Highest certainty on the whole list, and it is plumbing, not research.
2. **Within-episode action ledger, survives compaction** — kills A2, damps A3/A7. This is TerranSoul's actual novel claim, it is the mechanism no surveyed system implements, and it is the only item where our existing memory work is the differentiator. Retrieve dead ends as *negative constraints scoped to the current subgoal*, never as candidate plans (pollution guard).
3. **Budget as an observable** — elapsed/remaining exposed every turn, with a forced ship-the-artifact threshold. Attacks the largest bucket (79%). LemonHarness and harness-evolution independently converge on this.
4. **Exit gate requiring hard tool evidence** — converts B1 (19% of unresolved runs) from fatal to recoverable. Note in the writeup that this is a *stopping-policy* mechanism, not a memory mechanism.
5. **Recovery escalation ladder for stuck/interactive states** — A4. Small, cheap, well-defined.
6. **Capability probe cached once per episode** — A7, the single largest command-error class at 24.1%.

Do **not** build: cwd tracking as a headline feature (B3 is unmeasured), and nothing cross-episode (C-tier gains are unreachable and cross-task memory would be read as test-set learning).

**Falsifiable framing for the eventual claim:** memory does not raise the model's ceiling; it lowers the cost of reaching it, and on a benchmark where 79% of failures are clock exhaustion and failures cost 3.3× the tokens of successes, that converts to pass rate. If tokens/steps drop and pass rate does not move, the thesis is falsified — and we should pre-register that.

**Sources:** [TB 2.1 leaderboard](https://www.tbench.ai/leaderboard/terminal-bench/2.1) · [TB 2.1 repo](https://github.com/harbor-framework/terminal-bench-2-1) · [SUBMIT.md](https://github.com/harbor-framework/terminal-bench-2-1/blob/main/leaderboard/SUBMIT.md) · [Terminal-Bench paper](https://arxiv.org/html/2601.11868v1) · [Long-Horizon Terminal-Bench](https://arxiv.org/html/2607.08964v1) · [TerminalWorld](https://arxiv.org/html/2605.22535v1) · [Terminal-World (skills)](https://arxiv.org/pdf/2605.20876) · [Harness Evolution](https://arxiv.org/html/2607.12227) · [Meta-Harness / TerminalBench-2](https://www.emergentmind.com/topics/terminalbench-2) · [LemonHarness](https://arxiv.org/abs/2606.24311v1) · [MAST / IT-Bench](https://huggingface.co/blog/ibm-research/itbenchandmast) · [MSCE](https://arxiv.org/html/2607.16621) · [TraceRetain](https://arxiv.org/html/2606.29178v1) · [Terminal Wrench](https://arxiv.org/html/2604.17596) · [Leaderboard integrity update](https://www.tbench.ai/news/leaderboard-integrity-update) · [Terminus](https://www.tbench.ai/news/terminus)

---

## 5. GAP ANALYSIS — TerranSoul today vs what a TB agent needs

I have what I need. Report follows.

---

# TerranSoul vs. a Terminal-Bench agent — gap analysis

Repo read-only. No files changed, no cargo, no bench.

## 0. The one-line orientation

TerranSoul's LLM agent loop is **~350 lines with a two-tool surface (`read_file`, `edit_file`) and no shell, no cwd, no session**. Everything else in `crates/coding/` (53,396 lines / 69 modules) is *repo-resident IDE + self-improve* machinery keyed to a pre-built `code_index.sqlite`, a git worktree, and `rules/milestones.md`. Terminal-Bench hands you a bare Docker container and an `instruction.md`. Almost none of the 53k lines applies.

`crates/brain/src/openai_agentic.rs:236`
```rust
const TOOL_NAMES: [&str; 2] = ["read_file", "edit_file"];
```
`crates/brain/src/agentic_cli.rs:159`
```rust
cmd.arg("--allowedTools").arg("Read Edit");
```

Both transports. That is the entire action space TerranSoul's own agent has today.

---

## 1. Capability matrix

| # | Capability a TB agent needs (Recon B/C) | What TerranSoul has today (file:line) | Gap |
|---|---|---|---|
| **EXECUTION SURFACE** ||||
| E1 | Persistent shell session (tmux/PTY) in the task container | **Nothing.** Zero `tmux`/`portable_pty`/`conpty` references in any `.rs`. `stdin` is always `Stdio::null()` (`execute_code.rs:282`, `code_act.rs:226`) | **absent** |
| E2 | Generic shell tool exposed *to the agent loop* | `execute_code::normalize_language` accepts `shell/bash/sh` + `powershell` (`execute_code.rs:487-497`) — but reachable only as MCP `brain_execute_code`, **not** in `TOOL_NAMES`. `code_act.rs:46-49` is Python/Node only, 10 s timeout (`:37`) | **large** |
| E3 | Persistent cwd + env across commands | `execute_sandboxed` creates `temp_dir()/ts_execcode_<pid>_<uuid>`, `current_dir(&sandbox_dir)`, `scrub_child_env`, then `remove_dir_all` (`execute_code.rs:262-298`). **No `cwd` parameter exists in the tool schema** (`mcp/tools.rs:1310-1316`) | **absent** |
| E4 | Interactive-prompt handling / escalation ladder (A4) | none — stdin null everywhere | **absent** |
| E5 | Container/workspace lifecycle | `exec_backend.rs:211-250` one-shot `docker run --rm --network none` per script, with silent fallback to local exec (`:303-310`) | **large** |
| E6 | Deterministic startup handshake + retry (A1, worth 2-5 pp arithmetic) | none; no agent-install/session-init path exists | **absent** |
| **AGENT LOOP** ||||
| L1 | Multi-turn tool loop | Real, working: `openai_agentic.rs:300-470` (OpenAI-compatible) / `agentic_cli.rs` (spawns `claude`) | **none** |
| L2 | Turn/iteration budget | `IterationBudget` refundable economy, brain-seeded, self-tuning (`coding/iteration_budget.rs`; `openai_agentic.rs:60-115`, default 30 turns) | **small** |
| L3 | Budget/clock as an *observable to the model* (A5 — 79 % of unresolved runs) | **none.** `system_prompt()` (`openai_agentic.rs:483-509`) never mentions turns, elapsed, or remaining | **absent** |
| L4 | Output truncation with re-query guidance | `tail_chars` char-safe cap 4 000 (`execute_code.rs:552-570`); `offload.rs` head/tail-20-line preview at 40 k chars | **small** |
| L5 | Truncation/continuation recovery | `should_resume_truncated_turn` + `MAX_CONTINUATIONS = 6` (`openai_agentic.rs:219, 363-375`) — genuinely good | **none** |
| L6 | In-loop context compaction | **`prune_stale_images` only** (`openai_agentic.rs:607`) — drops old image payloads. No summarization, no window management. `SummarizationHook` (`coding/summarization_hook.rs:65`) and the whole hook chain (`runtime_hooks.rs:415/424/433`) have **zero production callers** — only tests and `doctor.rs:139`, which runs an *empty* chain as a health probe | **large** |
| L7 | Context-overflow handoff ritual (Terminus 2) | none | **absent** |
| L8 | Anti-premature-submission / two-phase confirm | **none.** Prompt says: *"When you are finished, reply with plain text and no tool call — that plain-text reply is treated as your final answer."* (`openai_agentic.rs:506-508`) | **absent** |
| L9 | Multi-perspective completion checklist (KIRA) | none | **absent** |
| L10 | Reasoning-effort scheduling (Tier-1, +2.9 pp) | **Present and real**: `model_supports_effort` lists `opus-4-8`; `output_config.effort` low→max, no `thinking` field (`brain/anthropic_client.rs:20-24, 153-165`). `--effort` already plumbed through `--agent-task` (`cli.rs:1951`) | **small** — the *dial* exists, the *schedule* (high-plan / med-implement / high-verify) does not |
| L11 | Environment bootstrap snapshot (Tier-1, +1.7 pp) | none | **absent** |
| **VERIFICATION / EXIT** ||||
| V1 | Exit gate demanding hard tool evidence (B1, 19 % of unresolved) | **Closest asset in the repo.** CA-1 verification-evidence ledger: `crates/memory/src/verification.rs:1-28`, `store.rs:6707/6733`, states unverified/passed/failed/**stale**, classified from **exit code only**, bounded at seeded `max_verify_attempts=2`. Wired at `cli.rs:1525-1541` + `2266-2300` | **large** — see below |
| V1a | …but: it is **post-hoc, not in-loop** — fires *after* the run ends and re-runs one whole extra `run_agentic_task` as a nudge (`cli.rs:2276-2300`) | | |
| V1b | …and it is **OpenAI-arm only**. It keys on `outcome.edited_paths`, which `agentic_cli.rs:74-80` documents as **always empty** for the spawned-`claude` transport. On our Opus arm the gate is dead code | | |
| V1c | …and it only triggers on *file edits*. A TB task solved by running commands (service config, package build, data transform) never trips it | | |
| V2 | Self-run test/verify primitive | `coding/test_runner.rs` — sandboxed spawn, 300 s/suite, retry-once flaky classification, 4 KiB tails, env scrub. Solid but hardcoded to Cargo/Vitest + `Custom` | **small** |
| V3 | Verification *correctness* (B2) | `orchestrator/self_rag.rs` reflection tokens (`<Supported>` FULLY/PARTIALLY/NO); `brain_verify_completion` LLM-judge (`mcp/tools.rs:260`) — but scoped to retrieval answers, and **`objective_delta` fields are `score_delta`/`inventory_gained`** (Zork residue), not exit codes | **large** |
| **MEMORY / ANTI-REPEAT** ||||
| M1 | Within-episode action ledger surviving compaction (A2) | `LoopDetector` exists as pure, I/O-free code: 3 identical `(context, action, response)` → `DeadEndSignal` (`crates/shared-types/src/loop_detect.rs`). **Wired ONLY into desktop chat** (`commands/streaming.rs:8277 observe_chat_loop_harness`, `session_id="chat"`). **Neither `openai_agentic.rs` nor `agentic_cli.rs` contains a single `loop_detect` / `observe_outcome` reference** | **large** — the mechanism exists, the wire does not |
| M2 | Per-turn selective memory injection | `enrich_agent_task_prompt` (`cli.rs:2032-2117`) — **one-shot prefix at prompt-build time only**, never mid-episode. This is the "always-inject at start" variant that Recon B measures as *losing* to two-phase selective injection | **large** |
| M3 | Episode trajectory recording | `agent_traces` table + `write_trace` (`memory/traces.rs:50`, `store.rs:7660`) — but the **only** call sites are `commands/streaming.rs:8374/8389` (chat). An `--agent-task` run writes **zero traces** | **large** |
| M4 | Cached capability probe (A7 — 24.1 % of command errors) | none | **absent** |
| M5 | Retrieval stack (RRF/HippoRAG/graph/verify-rank/deep-research) | Extensive and measured: `orchestrator/agentic_verify_rank.rs` (3,780 L), `deep_research.rs` (1,925 L), `agentic_rag.rs`, `self_rag.rs` | **N/A — nothing to retrieve from in a fresh container** (see §3) |
| **SUBMISSION MECHANICS** ||||
| S1 | ATIF trajectory emission (**hard CI gate**) | `brain_export_trajectory` writes **ShareGPT JSONL** from `agent_traces` (`mcp/tools.rs:844`) — wrong format, and the source table is empty on the agent path | **absent** |
| S2 | Harbor `BaseAgent` Python adapter | No `terminal-bench`/`harbor` reference anywhere in the repo (grep: 7 hits, all incidental prose in `benchmark/*.md`, `docs/*.md`, `session_names.rs`) | **absent** |
| S3 | Token/cost accounting per trial | `brain/usage_ledger.rs`, `coding/cost.rs`, `ChatCompletionUsage` | **small** |
| S4 | An episodic bench bridge as prior art | `benchmark/scripts/zork-bench/terransoul_brain_bridge.py` — 7,306 lines of Python implementing `LoopBreaker`, frontier routing, `tried_cardinals_by_room`, utility ledgers, contrastive heuristics. **This is the within-episode memory system we want — in Python, for a text adventure, driving someone else's agent, and in tension with `rules/mcp-single-source-of-truth.md`** ("no thick logic in bridges") | **large** |
| **SAFETY POLICY (inverted risk on TB)** ||||
| P1 | Ability to run destructive-looking-but-legitimate commands | `BashValidationRules::default` flags `rm -rf`, `rm -r`, `git reset --hard`, `git clean -fd`, `truncate -s 0`, `dd if=`, `chmod -r 000` (`coding/sandbox.rs:198-206`) and path prefixes `/etc /usr /bin /sbin /boot /dev /sys /var ~` (`:207-210`). `BashRiskPolicy::default` maps destructive→**Ask**, sensitive_path→**Ask**, unknown kind→**Ask** (`:400-410`), and `execute_sandboxed` **fails closed** with no approval channel (`execute_code.rs:748-753`) | **large** — correct for a desktop resident, fatal for a container agent |
| P2 | Cold-start autonomy | `--agent-task` calls `state.gate(ActionCategory::CodeExecute, …)` and returns `Denied` (`cli.rs:2220`). `ActionCategory::CodeExecute` is **deny-by-default until Laplace confidence clears the seeded threshold** (`memory/action_trust.rs:13-17`); unmapped tools also default to `CodeExecute` (`:39-49`) | **large** |
| P3 | Secrets denylist vs. real tasks | `SecretsDenylist` rejects any script token matching `**/.env`, `**/*.pem`, `**/id_rsa*`, `**/*.key` (`coding/sandbox.rs:13-20`), enforced pre-spawn | **medium** — TB has legitimate cert/key/env tasks |
| P4 | Leaving no unrequested filesystem state (KIRA "minimal state changes"; TB tests inspect **final container state**) | `offload.rs:35/38` writes `<worktree>/.terransoul/tool_results/` and `<worktree>/.terransoul/shell_output/`; `.terransoul/` litter in `/app` is a live correctness hazard | **large** |
| P5 | No cross-task learning (purity + maintainer optics) | `CodeActConfig::self_improve` defaults **true** (`code_act.rs:109`) and persists every successful snippet to the brain (`:270-286`); `brain_execute_code` logs every run into the procedural ledger and can auto-fire skill synthesis (`mcp/tools.rs:1309`). Across 445 trials this is cross-episode learning on a test set | **large — must be explicitly disabled** |

**Also worth flagging:** on 2026-08-01 the MCP wire surface was cut to **nine** `brain_*` tools (`mcp/tools.rs:1532-1562`). `brain_verify_completion`, `brain_observe_outcome`, `brain_execute_code`, `brain_compact_working_memory`, `brain_reason_budget`, `brain_goal_stack`, `brain_export_trajectory` are all **no longer reachable over MCP**. So the cognitive machinery is unreachable from an external agent *and* unused by our own agent loop. Under `rules/no-unexercised-features.md` that is the `graph_rag.rs`-with-zero-callers pattern, at scale.

---

## 2. Question 1 — do we already have a Terminal-Bench agent?

**No. This is "build a new agent," and it is not close.** Blunt breakdown:

**What actually transfers (~15 % of the work, and it is the easy 15 %):**
- `brain/anthropic_client.rs` — Opus 4.8 + `output_config.effort` low/medium/high/xhigh/max, already gated per-model. This is Tier-1 reasoning-effort scheduling's engine, ready to use.
- `openai_agentic.rs:300-470` — a *correct* tool loop skeleton: streaming, tool-tag parsing, truncation-continuation, budget refunds.
- `coding/iteration_budget.rs` — refundable brain-seeded turn economy with a self-tuning log.
- `memory/verification.rs` — exit-code-only, domain-free verify classifier + staleness rule. The right raw material for an exit gate.
- `shared-types/loop_detect.rs` — pure, allocation-light dead-end detector.
- `execute_code.rs` truncation (`tail_chars`) and `offload.rs` preview.
- `test_runner.rs` retry/flaky classification.

**What does not transfer at all:**
- `symbol_index.rs` (2,363 L), `processes.rs`, `repo_map_pagerank.rs`, `code_search.rs`, `diff_impact.rs`, `rename.rs`, `clusters.rs`, the whole `code_*` MCP family — every one of them needs a pre-built `code_index.sqlite` over a known repo. A TB container has none.
- `engine.rs` (3,170 L) — reads `rules/milestones.md`, picks the next `not-started` chunk, runs a fixed 6-node DAG, opens branches/PRs. Structurally a different product.
- `worktree.rs`, `branch_*`, `git_ops.rs`, `github.rs`, `pr_autofix.rs`, `kanban.rs`, `milestones.rs`.
- `multi_agent.rs` (2,423 L) is explicitly *"the planner/data-model half only… defines no executor and calls no agent"* (`:11-14`).

**What must be built from zero, and is the actual project:**
1. A persistent shell/session tool inside the task container (E1-E6). This is the entire benchmark surface and we have literally nothing — no PTY, no cwd, no stdin, no session.
2. A Harbor `BaseAgent` Python adapter + **ATIF** trajectory emission. ATIF is a hard CI gate; we emit ShareGPT, from a table the agent path never writes.
3. A bench-safety profile that neutralises P1/P2/P3/P4/P5 without weakening the shipped product's defaults.
4. In-loop context management (L6/L7), an in-loop exit gate (V1), and budget-as-observable (L3).

The `--agent-task` CLI is a genuine, working agentic-edit capability. It is *not* a terminal agent, and its 2-tool surface is a deliberate safety design (`agentic_cli.rs:20`: *"no `--allowedTools`-widening beyond `Read Edit`"*), not an oversight to be flipped.

---

## 3. Question 2 — is there a real mechanism by which our memory layer beats Claude Code on the same model?

**Honest answer: not for +4.9 points, and probably not for +2.8 either. The memory thesis is the weakest part of this project, and I would not stake the submission on it.** Four reasons, in descending order of how much they should worry us:

### 3.1 The retrieval stack has nothing to retrieve from — this is a scope mismatch, not a tuning problem

Everything we have *measured* — LongMemEval R@5 100 %, JD-million precision@10 1.00, HippoRAG/RRF/graph/verify-rank/deep-research — is **retrieval over a large corpus of prior conversations**. A Terminal-Bench episode starts with one `instruction.md` and an empty brain. `agentic_verify_rank.rs` (3,780 L), `deep_research.rs` (1,925 L), the KG, the graph walk, `brain_search`'s thinking-mode ladder: on trial 1, turn 1, they retrieve from a corpus of size zero. Our headline numbers do not transfer, and no amount of tuning makes them.

What *could* transfer is the within-episode ledger — memory of what this episode already tried. That is a different system, and per Recon C **nobody in the surveyed literature has built it** (TraceRetain is post-hoc episode summaries; MSCE requires ≥n_min distinct episodes). Genuine novelty, and correspondingly **zero external prior that it works.**

### 3.2 It is not wired to anything, so we have no internal evidence either

`openai_agentic.rs` and `agentic_cli.rs` contain **zero** references to `loop_detect`, `observe_outcome`, `write_trace`, or `brain_search`. Memory touches the agent path exactly once — `enrich_agent_task_prompt` (`cli.rs:2032`) prepends a RAG block before turn 1 — and never again. The dead-end detector is wired to *chat* (`streaming.rs:8277`, `session_id="chat"`). `agent_traces` is written only by *chat* (`streaming.rs:8374`).

So the claim "our memory layer makes an agent better" is not merely unbenched on Terminal-Bench; it is **unexercised inside our own product on the agent path**. That is the `rules/no-unexercised-features.md` trigger.

### 3.3 The published decay curve puts us inside the error bar

Recon B's proactive-memory-injection numbers: **Sonnet 4.5 +8.3 pp → Opus 4.6 +2.4 pp** — a 3.5× decay as the model gets stronger. Extrapolated to Opus 4.8, a pure memory layer projects to **≈+1 to +2.5 pp**. Recon C's arithmetic: beating 78.9 ± 1.3 at 2 SE needs ≈ +3.6 pp, and with their SE fixed the floor is +2.6 pp even with infinite trials on our side. A memory layer alone lands *under* the noise floor.

And we voluntarily forfeit the biggest published memory gains: cross-episode memory (MSCE +15.4) is barred by `rules/bench-agi-purity.md` and would read to a maintainer reviewing 445 public trajectories as test-set learning. That is the right call — and it is expensive.

### 3.4 Where memory *does* have a real, nameable mechanism (and how much it is worth)

Being fair to the thesis, three Recon-C failure modes are genuine hits, and we have the pure code for the first:

| Failure | Mechanism | Asset | Honest value |
|---|---|---|---|
| **A2** — post-compaction re-proposal of already-failed solutions (MAST FM-1.4, *fatal*; 24 % → 0 % across models = a context-management property) | Durable within-episode action ledger that survives compaction; retrieve dead ends as **negative constraints on the current subgoal only** | `shared-types/loop_detect.rs` (pure, needs wiring) + `memory/traces.rs` | Real, but L6 says we do not compact at all yet — so A2 cannot even *occur* in our loop today; it appears only once we add compaction |
| **A3/A7** — redundant exploration; missing executables (24.1 % of command errors) | Per-episode capability + negative-fact cache | none | Cheap to build, mostly a *token* win; converts to score only via A5 |
| **A5** — clock exhaustion (79 % of unresolved runs) | Budget as an observable | `iteration_budget.rs` counts **turns**, not wall-clock, and is invisible to the model | This is the big bucket, and the fix is **not memory** — it is exposing the clock |

The causal story worth pre-registering is Recon C's: *memory does not raise the ceiling, it returns budget to the part of the horizon where the task is solved.* Falsifiable: if tokens/steps drop and pass rate does not move, the thesis is dead. We should say that up front.

### 3.5 So where would +4.9 actually come from?

Not from memory. From things we do **not** have and that are **not** memory:

- **A1 deterministic startup + retry — 2-5 pp of pure arithmetic**, because errored trials score 0 and are not excluded. Highest-certainty item on the entire list, and it is plumbing.
- **Exit gate demanding hard tool evidence in-loop (B1, 19 % of unresolved)** — we have the classifier (`verification.rs`) and none of the wiring; today's gate is post-hoc, edit-keyed, and dead on the Opus arm.
- **Reasoning-effort sandwich** — +2.9 pp isolated, and it dodges the −9.7 pp flat-max timeout trap. We already have the dial (`anthropic_client.rs:153-165`); we need the schedule.
- **Environment bootstrap** — +1.7 pp, and it was the *only* net-positive edit in 10 Meta-Harness iterations.
- **Anti-premature-submission + completion checklist** (KIRA bundle, +11.8 pp vs. Terminus 2) — we currently do the exact opposite (`openai_agentic.rs:506`).

**Recommendation.** If this ships, the honest name is **"TerranSoul harness"**, and the memory layer is one **pre-registered ablation arm** — run with and without the episode ledger, and be willing to publish "memory contributed ≈0" if that is what the numbers say. Selling this as a memory win before measuring it is how we end up with a public submission that disproves our own thesis, which is precisely the outcome this analysis is supposed to prevent.

**Corollary, and I think the more interesting project:** Recon B/C both show memory and harness-engineering gains *peak on weak models* (Self-Harness +14 to +21 pp; memory +8.3 pp on Sonnet 4.5). The **local gemma4:12b arm is where our differentiator has real headroom** — and `openai_agentic.rs` is already the gemma4 transport. It needs the same new shell agent, but there the claim ("first fully-local entry", plus a large measured memory delta) is one we can actually defend.

---

## 4. Three findings that will bite regardless of which arm ships

1. **`.terransoul/` litter in the workspace.** `offload.rs:35/38` writes `<worktree>/.terransoul/tool_results/` and `/shell_output/`. TB tests inspect **final container state**, and KIRA's checklist includes a "leave nothing else altered" audit. Must be redirected outside the task workdir.
2. **Self-improve defaults are on.** `CodeActConfig::self_improve = true` (`code_act.rs:109`) persists every successful snippet to the brain; `brain_execute_code` logs every run into the procedural ledger and can auto-trigger skill synthesis (`mcp/tools.rs:1309`). Across 445 trials that is cross-episode learning on a test set — a `/judge` finding waiting to happen. Must be explicitly off, and said so in the submission.
3. **The safety stack fails closed on legitimate work.** `rm -rf` → Ask → no approval channel → hard error (`sandbox.rs:198-210`, `:400-410`, `execute_code.rs:748-753`), plus `CodeExecute` deny-by-default at cold start (`cli.rs:2220`, `action_trust.rs:13-17`). A bench profile is required — and it must be a *profile*, not a weakening of shipped defaults, or we trade a leaderboard row for a product regression.

**Files worth reading before planning:** `D:\Git\TerranSoulApp\crates\brain\src\openai_agentic.rs`, `D:\Git\TerranSoulApp\crates\brain\src\agentic_cli.rs`, `D:\Git\TerranSoulApp\src-tauri\src\cli.rs` (lines 1500-2310), `D:\Git\TerranSoulApp\crates\memory\src\verification.rs`, `D:\Git\TerranSoulApp\crates\shared-types\src\loop_detect.rs`, `D:\Git\TerranSoulApp\crates\coding\src\execute_code.rs`, `D:\Git\TerranSoulApp\crates\coding\src\sandbox.rs`, `D:\Git\TerranSoulApp\src-tauri\src\ai_integrations\mcp\tools.rs` (lines 1495-1562).