> **ARCHIVED — Terminal-Bench 2.1.** This document belongs to the closed 2.1
> campaign (Claude Code agent loop + `claude-sonnet-5`). It is retained for
> provenance and is **not** current guidance. The active campaign is
> Terminal-Bench 3.0; see `benchmark/terminal-bench/`.
# Terminal-Bench 2.1 — capability audit and teaching curriculum (2026-08-03)

> Read this BEFORE any Terminal-Bench work. It overturns two assumptions the earlier
> `terminal-bench-submission-plan.md` was built on.
>
> **1. The dev set I proposed is 39% contaminated.** `terminal-bench-core@0.1.1` shares **27 of its
> 70 base ids with the 89 scored TB 2.1 tasks**, 26 of them with **byte-identical instruction text**,
> and **88 of the 89** scored tasks exist in the public `terminal-bench/original-tasks/` pool. TB 2.1
> is a re-hardened SUBSET of the same public pool, not a separate set. Training on core@0.1.1 as
> shipped is training on the test set. Filters are mandatory — see the curriculum section.
>
> **2. Scaffold work is capped at ~3-5 points; the consistency gap is 9-22.** Measured from the 20
> checked-in 2.1 submissions. That inverts the strategy: our harness cannot be the story, and the
> memory layer can be.

---

## PART 1 — CAPABILITY AUDIT

## Terminal-Bench 2.1 — Capability Profile (AUDIT PHASE)

**Method.** Cloned `harbor-framework/terminal-bench-2-1` to scratchpad (read-only; nothing in `D:\Git\TerranSoulApp` touched). Parsed all 89 `task.toml`, read all 89 `instruction.md`, all 89 `environment/Dockerfile`, all 89 `tests/test.sh` + `tests/test_outputs.py`. **`solution/solve.sh` was never opened.** Cross-referenced with the Terminal-Bench paper (arXiv 2601.11868, incl. its empirical-difficulty ordering and official failure taxonomies) and the 20 real leaderboard submissions checked into `leaderboard/submissions/`. MCP receipt: `:7421` and `:7422` dead, tray `:7423` healthy (`status ok`, 1860 memories, rag_quality 100%, llm_provider degraded/cold) — brain MCP *tools* are not exposed to this subagent, so no `brain_search` was possible; recording that as the blocker rather than skipping silently.

---

### 1. Category × difficulty, and where the points actually are

Confirmed from `task.toml` metadata: 89 tasks, **4 easy / 55 medium / 30 hard**, 16 categories.

| Category | n | easy | med | **hard** | hard share of category |
|---|--:|--:|--:|--:|--:|
| software-engineering | 26 | 3 | 10 | **13** | 50% |
| system-administration | 9 | 0 | 7 | **2** | 22% |
| scientific-computing | 8 | 0 | 5 | **3** | 38% |
| security | 8 | 0 | 6 | **2** | 25% |
| data-science | 8 | 0 | 6 | **2** | 25% |
| debugging | 5 | 1 | 4 | **0** | 0% |
| file-operations | 5 | 0 | 4 | **1** | 20% |
| model-training | 4 | 0 | 3 | **1** | 25% |
| mathematics | 4 | 0 | 1 | **3** | 75% |
| data-processing | 4 | 0 | 4 | **0** | 0% |
| machine-learning | 3 | 0 | 2 | **1** | 33% |
| games / personal-assistant / optimization | 1 each | 0 | 1 | **0** | 0% |
| data-querying / video-processing | 1 each | 0 | 0 | **1** | 100% |

**Software-engineering carries the Hard tier outright: 13 of 30 hard tasks (43%).** Add mathematics (3), scientific-computing (3), system-administration (2), security (2), data-science (2) and you have 25 of 30. Debugging and data-processing contain **zero** hard tasks.

**The more important finding: the published label understates the hard tier.** The paper's "empirical difficulty" (resolved by <33.3% of frontier models under Terminus 2) shows 93.3% of human-hard tasks are also model-hard — but **54.5% of human-*medium* tasks are model-hard too**. That is ~28 + ~30 ≈ **58 of 89 tasks that are empirically hard**. The single biggest bloc of winnable-but-unwon points is the **human-medium / model-hard band (~30 tasks)**, which the paper characterises as needing "creative or adversarial reasoning rather than pattern-following." Optimising only against the 30 `difficulty="hard"` rows targets the wrong half.

---

### 2. Capability matrix

Hand-classified from instruction + tests + Dockerfile for all 89 (regex passes were used only to cross-check). "Emp. rank" = mean position in the paper's empirical resolution-rate ordering, 0 = easiest, 88 = hardest, **44.0 = neutral**; it is the strongest single column in this table.

| Capability | n/89 | % | hard/30 | Emp. rank | Reads as |
|---|--:|--:|--:|--:|---|
| **Exact artifact at exact path/format** | 75 | 84% | 26 | 44.7 | universal tax, not a discriminator |
| **Spec inference / reverse engineering** (acceptance criterion not fully stated) | 56 | 63% | 24 | 49.6 | **discriminator** |
| **Package & dependency management** | 41 | 46% | 11 | 44.1 | neutral |
| **Numeric/algorithmic correctness under tolerance** | 29 | 33% | 18 | **58.7** | **strongest discriminator** |
| **Long multi-stage sequence** (≥4 dependent stages) | 25 | 28% | 8 | 38.6 | easier than average |
| **Build toolchain / compile from source** | 23 | 26% | 9 | 43.7 | neutral |
| **Log / trace / binary diagnostic reading** | 20 | 22% | 5 | 37.4 | easier than average |
| **Hard resource budget** (bytes / seconds / RAM / 1 CPU) | 18 | 20% | 11 | **54.5** | **discriminator** |
| **Constrained file surgery** ("touch only X", "leave Y byte-identical") | 14 | 16% | 2 | **27.6** | already solved |
| **Performance optimisation vs an explicit baseline** | 11 | 12% | 3 | 40.8 | neutral |
| **Service startup, still live at grade time** | 10 | 11% | 2 | **30.5** | already solved |
| **Network serve/connect** (ports, HTTP, SSH, gRPC, telnet) | 10 | 11% | 2 | **30.5** | already solved |
| **Debug a pre-existing failure** (given broken artifact) | 8 | 9% | 2 | **22.8** | **easiest band** |
| **Network fetch / web research** | 8 | 9% | 1 | 50.0 | mild discriminator |
| **Interactive prompt / PTY / console driving** | 8 | 9% | 2 | 37.8 | easier than average |

Mean capabilities per task = 4.0, and it is **flat across difficulty** (hard 4.2, medium 3.9, easy 3.8). Difficulty is not breadth; it is depth in specific capabilities.

Capability profile of the empirically hardest bands (task names withheld):

- **Bottom-10 (near-zero resolution across all models/agents):** spec inference 9/10, exact artifact 8/10, numeric correctness 6/10, package mgmt 6/10, hard resource budget 3/10. Human labels: 8 hard, 2 medium. 9/10 run on 1 CPU. Category: software-engineering 5/10.
- **Bottom-25:** exact artifact 22, spec inference 20, package mgmt 13, numeric correctness 12, resource budget 8. 23/25 on 1 CPU; median agent budget 30 min.
- **Top-25 (easiest):** exact artifact 21, package mgmt 12, spec inference 11, long multi-stage 8, diagnostics 7, service-live 6. Median agent budget 15 min.

**The counter-intuitive result worth carrying forward: the "sysadmin" capabilities everyone assumes are the wall — bring a service up, keep it alive, drive an interactive console, read a stack trace, do surgical edits under a do-not-touch constraint — are the *easiest* band for frontier models (emp. rank 22–38 against a 44 baseline). The wall is getting a numerically/algorithmically exact answer, inside a hard budget, from an under-specified instruction.**

---

### 3. THE FAILURE SURFACE — model limit vs harness limit

Three independent measurements bound the split.

**(a) Harness ceiling ≈ 3–5 points; model ceiling ≈ 25 points.** From the 20 checked-in 2.1 submissions, same model across two scaffolds: 83.8 vs 80.5, 83.2 vs 78.0, 68.9 vs 66.1, 65.8 vs 65.6. Across models on the same scaffold family: 58.6 → 83.8. Scaffold engineering is real but bounded; it cannot be the main story.

**(b) The consistency gap ≈ 9–22 points — and it is bigger than the harness gap.** pass@1 vs pass@5 on the same 445 trials:

| pass@1 | pass@5 | gap |
|--:|--:|--:|
| 83.8 | 93.3 | 9.4 |
| 83.2 | 94.4 | 11.2 |
| 78.9 | 94.4 | 15.5 |
| 74.6 | 92.1 | 17.5 |
| 65.8 | 87.6 | 21.8 |

pass@5 sits at 92–95% for every frontier model. **Only ~5–7% of tasks are never solved in five tries (true capability wall). 10–16% are solved *sometimes* — the model already has the capability and loses it to run-to-run discipline.** That band is the largest single teachable target in the whole benchmark, and it is bigger than everything scaffold work can buy.

**(c) The official taxonomies name the failures.** Trajectory level (paper §4.4, GPT-5 judge, 90% human agreement): **Execution errors dominate for frontier models** — *Disobey specification*, *Step repetition*, *Unaware of termination conditions* — with Coherence (*reasoning–action mismatch*, *context loss*, *derailment*) and Verification (*premature termination*, *no/incorrect verification*, *weak verification*) lower but comparable. Command level (§4.5, 3,800 sampled failures): per-model command error rates **9.2% → 26.7%**; distribution **Invocation 35.1% / REPL 19.1% / Runtime 15.5% / Filesystem 14.1%**, with the single largest leaf **"command not found on PATH" at 24.1%**, then app-failure 9.6%, file-not-found 11.1%, module-not-found 8.3%.

Per-capability split:

| Capability | What goes wrong | Limit type |
|---|---|---|
| Build toolchain | Compiler/headers absent, wrong flags for an old codebase, `make -j` on 1 CPU thrashes | **Harness-fixable** (probe + serial builds); model-limited only for genuinely obscure toolchains |
| Service startup | Started in foreground and it dies when the agent's session ends; never health-checked before declaring done | **Harness-fixable** — and empirically already mostly solved (rank 30.5) |
| Debug given failure | Rarely the blocker; emp. rank 22.8 | Neither — already solved |
| File surgery | Collateral edits to files the tests hash | **Harness-fixable** (re-read the do-not-touch clause at the end); rank 27.6 = mostly solved |
| Networking | Almost never the blocker at this tier | Neither |
| Package management | Installed into the *wrong* interpreter/env (83/89 graders build their own pinned venv); version pin ignored | **Harness-fixable** — this is `module not found` 8.3% + `conflicting env managers` |
| **Long multi-step sequences** | Step repetition, context loss across a summarisation boundary, derailment | **Harness-fixable** (state file, explicit stage ledger) |
| Interactive prompts | Blocking on a prompt with no way to answer; command starts interactive by default | **Harness-fixable**; rank 37.8 |
| Log/diagnostic reading | Rarely the blocker | Neither |
| Resource cleanup / budget | Blows the byte/second budget; fills the 10 GB disk; OOMs at 2 GB | **Mixed** — measuring is harness, *fitting the budget* is model |
| **Numeric correctness under tolerance** | Answer plausible but outside tolerance; wrong source of truth | **MODEL LIMIT.** rank 58.7. No scaffold fixes this |
| **Spec inference / reverse engineering** | Guesses the acceptance criterion instead of deriving it | **Mostly model limit** (rank 49.6), with a harness-fixable slice: actually *reading* the artifacts that state it |
| **Verification before declaring done** | Declares success without running the check that exists; "tests passed" contradicted by artifacts | **PUREST HARNESS WIN.** Whole Verification class of the official taxonomy |

**Bottom line for teaching:** the ~5–7% never-solved band is a raw-capability wall (deep algorithmic/numeric work under a budget) — teaching cannot move it. The ~10–16% consistency band plus the Execution/Verification failure classes plus the 35.1% invocation-error mass are scaffold-and-discipline limits — teaching *can* move them, and they are worth more points than the model gap between adjacent frontier releases.

---

### 4. Environment shape — and whether a probe pays off

Startlingly uniform, which is itself the finding.

- **Base images:** 46 `python:*-slim` (mostly 3.13-bookworm), 39 `ubuntu:24.04`, 4 `debian:*-slim`. **Two families cover 85 of 89.**
- **Resources are near-constant:** every task = `gpus 0`, `storage 10240 MB`, `build_timeout 600 s`, `allow_internet true`, `mcp_servers []`. **83/89 get 1 CPU** (3 get 2, 3 get 4). Memory: 68 × 2 GB, 13 × 4 GB, 8 × 8 GB. Hard tier is *not* given more: 28/30 hard tasks run on 1 CPU, 22/30 on 2 GB.
- **Images are prebuilt and published under a single registry namespace** — the Dockerfile is baked, the agent starts in a prepared container.
- **Dockerfiles are thin: median 11 lines.** Explicit installs across all 89: `pip` 33, `git` 18, `curl` 16, `gcc` 15, `python3` 13, `make` 11, `build-essential` 9, `g++` 8. **25 of 89 install nothing at all.** Neither base family ships gcc/git/curl by default, and `ubuntu:24.04` ships no python.

**An environment probe pays off, and the benchmark's own data says so twice.** First, the largest command-failure leaf is *command-not-found on PATH at 24.1%*, and the whole Invocation class is 35.1% — precisely the failure a probe prevents. Second, the maintainers' own `tests/test.sh` runs `apt-get update && apt-get install -y curl` in **80 of 89 tasks** before it can do anything: they do not assume curl exists either.

**Caching a probe across tasks pays off, but as a *decision tree*, not a snapshot.** Because two image families cover 85/89 with median-11-line deltas, a cached "which family am I in, and what does that family lack" model transfers almost perfectly. A cached *literal* inventory does not — the 11-line delta is exactly the task-relevant part. Probe cost is a handful of commands against a 900 s median budget; expected saving is a share of a 24.1% failure class.

---

### 5. What all-or-nothing scoring punishes

The grading contract, read out of `tests/test.sh` (identical boilerplate in **89/89** — zero customised graders):

```
pytest ... ; if [ $? -eq 0 ]; then echo 1 > reward.txt; else echo 0 > reward.txt; fi
```

Reward is 1 **iff the pytest process exits 0**. Tests inspect final container state only; they never inspect the agent's commands or console output.

Test-count distribution: median 3, mean 3.5. **22 tasks have exactly one test (9 of them hard)** — one assertion is the entire task. **25 tasks have ≥5.** Easy/medium/hard all average ~3.3, so the hard tier is not more forgiving.

**Where partial progress is worth exactly zero:**

1. **Everything below the last assertion.** 62/89 tests read a file the agent must have written at a literal path; 75/89 tasks demand an exact artifact. Correct work not serialised to the right path in the right format scores 0.
2. **Anything that breaks the box.** 80/89 graders run `apt-get update && apt-get install curl` **after** the agent stops — broken apt sources, broken DNS, or a full 10 GB disk zeroes a completed task. 87/89 abort outright if `PWD == /`. Damaging the environment is indistinguishable from failing the task.
3. **The wrong Python.** 83/89 graders build a fresh `uv` venv with pinned deps. 10 tasks `sys.path`-inject `/app`, so the agent's code executes under the **grader's** pinned versions, not the agent's; 18 tasks pull heavy pinned deps (numpy 12, pandas 5, pillow 5, torch 5, scipy 3, opencv 3). Code that works in the agent's environment and nowhere else scores 0.
4. **Overrun.** Errored trials score reward 0 and are **not excluded** (leaderboard rule, `SUBMIT.md` L41–42); `timeout_multiplier` must be unset or 1.0 and no resource overrides are permitted. 17 tasks additionally carry per-test timeouts inside the grader.
5. **Any single missed sub-clause** in tasks with 5–11 assertions.

**The budget is the binding constraint, and it is deliberately brutal.** 48/89 tasks give the agent 900 s; median hard-tier budget is 30 min. **In 71 of 89 tasks the agent's wall-clock budget is smaller than the task author's own *expert* time estimate** — 28 of 30 hard tasks, with a median expert:agent ratio of **10×** and a maximum of **160×**. Mean trial 799.6 s sits right against the 900 s cap. Meanwhile the paper finds **no correlation between episode count and success** (r ≈ −0.03) and none between output tokens and success: more turns do not buy anything.

**What that implies about keep-going vs stop-and-verify.** Grinding has zero measured expected value; verification has enormous expected value, because the entire Verification failure class (premature termination, no/incorrect verification, weak verification) converts already-correct work into zeros. The correct policy is a **hard reserve** — with a median 900 s budget and a mean 799.6 s trial, an agent that has not fenced off a final verification window will routinely be cut off mid-work with an unwritten artifact. Verification must re-derive the acceptance conditions from the instruction and re-check each one against the **final container state** (artifact exists, at the literal path, in the required format, service still listening, inputs still byte-identical, apt/DNS/disk still healthy) — not against the agent's memory of having done it. And the check must be adversarial about the grader's environment, not the agent's.

**Constraint on the curriculum phase, from the benchmark's own audit rubric** (`leaderboard/src/leaderboard/ci/analysis-task-template/instruction.md`): the Hacks column is produced by an LLM judge over uploaded ATIF trajectories, and it flags `task_level_reward_hacking` for "external task-keyed solutions," "hardcoding grader values," "verifier exploits," and "fabricating answers after abandoning real work" — plus `harness_level_cheating` for "injected hints/guidelines with task-specific solutions" and "answers in reasoning with no traceable derivation." Observed hack rates in the 20 submissions range 0.00% to 8.99%, and checked rows are zeroed and subtracted. **Any teaching artifact keyed to these 89 tasks would be scored as harness-level cheating on sight.** The capability-level framing above is not just methodologically cleaner — it is the only form that survives the audit.

**Sources:** [terminal-bench-2-1 repo](https://github.com/harbor-framework/terminal-bench-2-1) · [tasks dir](https://github.com/harbor-framework/terminal-bench-2-1/tree/main/tasks) · [Terminal-Bench paper (arXiv 2601.11868)](https://arxiv.org/abs/2601.11868) · [How to run Terminal-Bench 2.1](https://www.tbench.ai/docs/run-terminal-bench-2-1) · [Harbor framework](https://github.com/harbor-framework/harbor)

**Working files (scratchpad, safe to delete):** `C:\Users\DevStar\AppData\Local\Temp\claude\D--Git-TerranSoulApp\5d5a8a67-dbb7-472a-9c6e-229b8009ba83\scratchpad\` — `tb21/` (clone), `tb21_meta.json` (89 × task.toml metadata), `handtag.json` (capability tags), `paper.txt` (extracted paper text), `emp.py` / `envshape.py` / `handtag.py` (analysis).

---

## PART 2 — TEACHING CURRICULUM

## TERMINAL-BENCH 2.1 — TEACHING CURRICULUM (DESIGN)

**Method.** Cloned `harbor-framework/terminal-bench` (241 `original-tasks/`, `registry.json` with the pinned `terminal-bench-core@0.1.1` subset) alongside the audit-phase `terminal-bench-2-1` clone. Parsed every `task.yaml` in the candidate dev pool, read all instructions, counted graders, and diffed the dev pool against the 89 scored tasks by name and by instruction text. `solution/*` and `solution.yaml` were never opened, in either repo. Repo `D:\Git\TerranSoulApp` untouched (read-only greps only).

---

# 0. BLOCKER FOUND FIRST: the proposed dev set is 34% contaminated

Before any curriculum design, the contamination check:

| Check | Result |
|---|---|
| `terminal-bench-core@0.1.1` task ids (unique base ids) | 70 (80 rows incl. 10 `.easy`/`.hard`/`.base_with_hint` variants) |
| **Base ids that are ALSO scored TB 2.1 tasks** | **27 of 70 (39%)** |
| Of those 27, instruction text **byte-identical** between core@0.1.1 and 2.1 | **26 of 27** (the 27th, `extract-moves-from-video`, was rewritten; `reshard-c4-data` sim 0.97) |
| TB 2.1 task ids present in public `terminal-bench/original-tasks/` | **88 of 89** |

**TB 2.1 is not a separate task set from TB 1.0 — it is a curated, re-hardened subset of the same public pool.** Training on core@0.1.1 as shipped means training on 27 of the 89 scored tasks with identical instructions. That is not a subtle leak; it is the test set. It would also be visible to the leaderboard's Hacks audit, which reads uploaded trajectories and flags `harness_level_cheating` for injected task-specific guidance.

**Mandatory filters before anything else (implement as a script, run at corpus build time and re-run at every checkpoint):**

1. **Exact-id filter.** Drop every dev candidate whose id appears in the 89. Removes 27 from core@0.1.1 → **43 clean base ids** (40 with a readable directory in `original-tasks/`; `eval-mteb`, `super-benchmark-upet`, `vim-terminal-task` live only on branch `dataset/terminal-bench-core/v0.1.x` — pull that branch to get them plus the 10 difficulty variants).
2. **Extended pool, same filter.** `original-tasks/` (241) minus the 88 → **153 clean tasks** (60 easy / 66 medium / 27 hard), of which 113 are outside core@0.1.1 entirely. This is where the hard-tier dev material lives.
3. **Sibling-name quarantine.** 7 clean tasks are near-name twins of scored tasks and may share an environment or scaffold. Allowed in TRAIN only after a manual `environment/` + fixture diff proves they are distinct; **banned from PROBE and SEAL unconditionally**:
   `install-windows-xp` ~ `install-windows-3.11` · `port-compressor` ~ `write-compressor` · `log-summary` ~ `log-summary-date-ranges` · `extract-safely` ~ `extract-elf` · `build-stp` ~ `build-pmars` · `speech-to-text` ~ `gcode-to-text` · `jq-data-processing` ~ `video-processing`
4. **Canary GUID grep.** Every TB1 `task.yaml` carries `terminal-bench-canary GUID …`. Assert it is present in every dev task (proves provenance) and assert it never reaches a brain lesson.

---

# 1. COVERAGE MAP

Same A–N capability taxonomy as the audit. Dev column = the 40 readable clean core@0.1.1 tasks, hand-tagged from instruction + tests + Dockerfile. `ratio` = dev share ÷ 2.1 share; **1.00 = faithful, <0.6 = gap, >1.5 = over-trained**.

| | Capability | 2.1 n (%) | 2.1 hard | DEV n (%) | DEV hard | ratio | verdict |
|---|---|---|---|---|---|---|---|
| L | Exact artifact at exact path/format | 75 (84%) | 26 | 26 (65%) | 4 | 0.77 | thin in hard tier |
| K | Spec inference / reverse engineering | 56 (63%) | 24 | 20 (50%) | 5 | 0.79 | **hard tier 5 vs 24 — gap** |
| F | Package & dependency management | 41 (46%) | 11 | 13 (32%) | 2 | 0.71 | gap + wrong *kind* (see F below) |
| M | Numeric correctness under tolerance | 29 (33%) | 18 | 5 (12%) | 2 | **0.38** | **worst gap; strongest discriminator** |
| G | Long multi-stage sequence (≥4) | 25 (28%) | 8 | 14 (35%) | 2 | 1.25 | adequate |
| A | Build toolchain / compile from source | 23 (26%) | 9 | 5 (12%) | 0 | **0.48** | **gap, zero hard** |
| I | Log/trace/binary diagnostics | 20 (22%) | 5 | 10 (25%) | 1 | 1.11 | adequate |
| J | Hard resource budget | 18 (20%) | 11 | 4 (10%) | 2 | **0.49** | **gap; 11/30 hard in 2.1** |
| D | Constrained file surgery | 14 (16%) | 2 | 8 (20%) | 2 | 1.27 | adequate |
| N | Perf optimisation vs baseline | 11 (12%) | 3 | **0 (0%)** | 0 | **0.00** | **absent** |
| B | Service live at grade time | 10 (11%) | 2 | 5 (12%) | 0 | 1.11 | adequate |
| E2 | Network serve / connect | 10 (11%) | 2 | 8 (20%) | 0 | 1.78 | **over-trained** |
| C | Debug a pre-existing failure | 8 (9%) | 2 | 11 (28%) | 2 | **3.06** | **over-trained** |
| E1 | Network fetch / research | 8 (9%) | 1 | 5 (12%) | 0 | 1.39 | adequate |
| H | Interactive prompt / PTY driving | 8 (9%) | 2 | 7 (18%) | 1 | **1.95** | **over-trained** |

**The headline is the over-training, not the gaps.** C (3.06), H (1.95), E2 (1.78) are the three capabilities the audit measured as *already solved* by frontier models (empirical resolution rank 22.8 / 37.8 / 30.5 against a 44.0 baseline). Meanwhile M (rank 58.7, the single strongest discriminator) sits at 0.38 and N at 0.00. **Run the loop on unmodified core@0.1.1 and roughly a third of your ~137 iterations are spent teaching capabilities the student already has.**

Three further fidelity gaps that no capability tag captures:

| Property | TB 2.1 | DEV as shipped | Consequence |
|---|---|---|---|
| **Time pressure** — median (expert minutes × 60) ÷ agent timeout | **10.0×** (71/89 budget < expert time; max 160×) | **1.27×** (10/18 with estimates) | ~8× less pressure. Budget discipline — a top-3 teachable — is barely exercised. |
| **Grader environment** | 83/89 graders build a *fresh pinned `uv` venv*; 10 `sys.path`-inject `/app` so agent code runs under grader pins | `run-tests.sh` is `pip install pytest==8.4.1; pytest …` — **same system python the agent used** | The single most common 2.1 zero-score mechanism (works in my shell, not in the grader's) **cannot occur** on the dev set. |
| **Environment-damage sensitivity** | 80/89 graders `apt-get update && apt-get install curl` **after** the agent stops; 87/89 abort if `PWD == /` | no post-hoc network/apt dependency | Breaking the box is free on dev, fatal on 2.1. |
| Difficulty mix | 4 E / 55 M / 30 H | 16 E / 18 M / 6 H | dev skews easy; fix by drawing from the 153-task extended pool (27 hard available). |
| Grader sharpness | median 3 tests, 22/89 single-test | median 3 tests, 8/37 single-test | comparable — no action. |

## 1.1 Synthetic task specifications

Author in **Harbor format** so the dev loop and the scored run use one harness: `harbor task init <name>` → `instruction.md`, `environment/Dockerfile`, `tests/test.sh`, `tests/test_outputs.py`, `task.toml`, `solution/solve.sh`. Validate each with `harbor task check <name>` (LLM rubric — catches under-specification and reward-hacking surface), then `harbor task run <name> -a oracle` (must reward 1), then a **null run** (copy the task, empty `solve.sh`, run `-a oracle`; must reward 0 — proves the task is not already passing at container start). Port the TB1 tasks with `harbor tasks migrate`, then run the same three gates on each port.

Every synthetic uses the 2.1 environment envelope: base `python:3.13-slim-bookworm` or `ubuntu:24.04`, `cpus = 1`, `memory_mb = 2048`, `storage_mb = 10240`, `gpus = 0`, `allow_internet = true`, `build_timeout_sec = 600`. Budgets set per §1.2.

**Authoring invariant (non-negotiable):** no synthetic may be derived from, named after, or share a fixture with any of the 89. Each spec below is a *generator* — the implementer should instantiate it with substrate they choose, and re-instantiate it if it ever gets stale.

---

**SYN-N1 — Semantics-preserving speedup (targets N, +M, +L). TRAIN.**
*Goal.* The container ships a correct-but-slow reference implementation of a data reduction, a ~200 MB input generated at build time, and a `baseline.json` recording the reference's median wall time. Produce a drop-in replacement at a stated path that is **byte-identical in output** and **≥4× faster**.
*Environment.* python-slim, numpy pinned, 1 CPU / 2 GB. Ship a seeded input generator in the image but do **not** ship the second input.
*Test.* Generate a *hidden* second input at test time from the seeded generator; run reference and candidate on it; assert `sha256` equality of outputs; assert candidate median-of-3 wall ≤ baseline/4. Anti-shortcut assertions: make the shipped expected-output file mode `000` for the duration of the candidate run (reading it fails), and assert the candidate produces correct output on the hidden input in a fresh process with no warm cache.
*Why it generalises.* "Make it faster without changing semantics, and prove semantics on data you have not seen" is the entire N shape in 2.1, independent of substrate.

**SYN-N2 — twin, different substrate (N). PROBE.** A slow shell/text pipeline must be replaced by something ≥6× faster with identical stdout bytes on hidden input. `ubuntu:24.04`, coreutils only in the base.

---

**SYN-M1 — Convention trap under tight tolerance (M, K, L). TRAIN.**
*Goal.* Container has a dataset plus a `spec/` directory containing a prose description of a statistic **and** a reference implementation in a second language (R, Fortran, or Octave). Write the value to a stated path at 6 significant figures.
*Environment.* python-slim + the second-language runtime. No internet needed but allowed.
*Test.* Recompute truth by executing the shipped reference at test time on the same data; assert `abs(v − truth) / abs(truth) < 1e-9`. **One** convention divergence is built into the instance — sample vs population denominator, degrees vs radians, inclusive vs exclusive bound, 0- vs 1-based index. The prose is accurate but does not disambiguate; the reference does.
*Why it generalises.* Forces "find the artifact that *defines* the comparison" instead of "compute the obvious thing." Tolerance is tight enough that the wrong convention always fails and the right one always passes — no luck.

**SYN-M2 — Convergence to a stated bound on unseen data (M, F, J, L). TRAIN.**
*Goal.* Fit/derive a model or estimator whose stated metric must fall below a bound on a held-out split **generated at test time** from a seeded generator. Single assertion.
*Environment.* python-slim, numpy/scipy pinned, 1 CPU / 2 GB, no GPU, 900 s.
*Test.* Load the agent's artifact, evaluate on freshly generated data, assert metric ≤ bound; assert artifact size < a ceiling that excludes memorising the training set; assert held-out score within a stated band of train score (rejects lookup tables).

**SYN-M3 — Exactness, not tolerance (M). PROBE.** A combinatorial or number-theoretic quantity where float arithmetic is *close but wrong*. Single equality assertion on a big integer.

---

**SYN-J1 — Memory ceiling (J, +L). TRAIN.**
*Goal.* Transform an input larger than RAM (6 GB input, 2 GB cgroup) into a stated output format, delivering a **pipeline script at a stated path** as well as the output.
*Test.* Assert output correctness on sampled records; **re-run the agent's script under `ulimit -v` / a 2 GB cgroup on a fresh hidden input and require completion**. That is the whole point: the deliverable must be a bounded-memory *procedure*, not a one-off artifact produced by luck.

**SYN-J2 — Time ceiling (J). PROBE.** A script at a stated path must process hidden input within N seconds on 1 CPU; the naive approach is ~10× over.

---

**SYN-A1 — Build from source in a bare image (A, F, J). TRAIN.**
*Goal.* An old-style C/C++ project (autotools or hand-written Makefile) must be compiled to a named binary at a stated path. The base image has **no compiler** and is missing dev headers for one dependency. Internet allowed. 1 CPU.
*Test.* Binary exists, is ELF, linkage matches the stated requirement, produces stated output on hidden inputs — **plus** an environment-integrity block: `apt-get update` still succeeds and DNS still resolves at grade time.
*Why it generalises.* The A loop in 2.1 is always probe → install → configure → build **serially on one core** → verify, and it is always graded after the fact by a script that needs the box intact.

**SYN-A1' — twin, different ecosystem (A). PROBE.** A language toolchain absent from the base (Rust, OCaml, or Fortran) with a pinned version requirement.

---

**SYN-F1 — Grader-environment contract (F, L). TRAIN. Highest leverage in this list.**
*Goal.* A repo whose `tests/test.sh` builds its own pinned `uv` venv with versions **deliberately different** from the system interpreter's, and imports the agent's module from `/app` by `sys.path` injection. The agent's task requires an API that was renamed or removed between those two versions.
*Environment.* python-slim with system packages at version X; grader pins version Y.
*Test.* The stock Harbor boilerplate — **the contract is the test**. No custom assertions needed.
*Why it generalises.* This is the 2.1 grading contract in 83 of 89 tasks and it has **no analogue anywhere in TB 1.0**. If you build one synthetic from this list, build this one.

**SYN-F1' — twin (F). PROBE.** Same contract, inverted or in another ecosystem: grader pin *older* than system, or a Node project with a lockfile.

---

**SYN-V1 — Clobber trap / verification (Verification class, L, G). TRAIN.**
*Goal.* A four-stage task, **all stages stated plainly in the instruction**, where stage 3 legitimately requires an operation whose obvious implementation destroys or relocates the stage-1 artifact (a rotation, a cleanup, a directory-rewriting format migration).
*Test.* Assert the stage-1 artifact is present and correct **and** the stage-3 effect is present.
*Why it generalises.* Nothing is hidden and there is no trick; the task is passed by re-verifying final state and failed by trusting memory of having done stage 1. That is precisely the Verification failure class (premature termination / no verification / weak verification), converted into a 1/0 signal.

**SYN-V1' — twin (Verification). PROBE.** Different clobber mechanism: a required service restart that resets a config written earlier.

---

**SYN-E1 — Environment-damage guard (harness contract). TRAIN.**
*Goal.* An ordinary data/file task in a container that is *nearly* out of disk, where the obvious way to free space is to clear apt lists, remove a system package, or repoint the `python3` symlink.
*Test.* Task correctness **plus** an integrity block: `apt-get update` succeeds; DNS resolves; `python3 -c "import ssl"` works; free space > threshold; `PWD != /`; no dangling system symlinks.
*Why it generalises.* 80 of 89 scored graders install packages *after* the agent stops. On dev, breaking the box is currently free.

**SYN-E1' — twin (harness contract). PROBE.** Damage vector is network config / resolver rather than package state.

---

**SYN-K1 — Spec inference, hard tier (K, L, M). TRAIN.**
*Goal.* Given an opaque artifact (a stripped binary, a compiled module, or a black-box service) plus a handful of input→output examples, produce a program that reproduces the mapping on hidden inputs. **The mapping is never stated in prose.**
*Environment.* `ubuntu:24.04`, standard tooling. Internet allowed — but because the artifact is synthetic, search cannot shortcut it.
*Test.* Run the agent's program on hidden inputs; assert exact match. Assert the agent's program does not shell out to the opaque artifact.
*Why it generalises.* K appears in 24 of 30 hard 2.1 tasks and the dev set has 5. This is the largest single hard-tier deficit.

**SYN-K2 — twin, different modality (K). PROBE.** An undocumented wire protocol or container file format rather than a function.

---

**Authoring cost:** 9 TRAIN + 8 PROBE twins = **17 synthetic tasks**, ~1.5–2 engineer-days each including the three validation gates. Budget a week. The PROBE twins must be authored **from the capability spec alone, by a session that has not seen the TRAIN synthetics**, and frozen before iteration 1 — otherwise they measure recall of your own authoring style rather than capability.

## 1.2 Dev-corpus assembly and budget compression

| Split | n | Composition |
|---|---|---|
| **TRAIN** | 49 | 28 TB1-clean (the 40 minus the 12 PROBE picks) + 12 hard/medium from the 153-task extended clean pool, chosen to fill M/J/N/A/K deficits + 9 TRAIN synthetics |
| **PROBE** | 20 | 12 TB1-clean (§4) + 8 PROBE-twin synthetics |
| **SEAL** | 12 | drawn from the 21 hard extended-clean tasks (§4); never in TRAIN or PROBE |
| **Total** | **81** | |

**Target TRAIN difficulty mix ≈ 5 easy / 20 medium / 24 hard.** The easy tier serves only as canaries. Achieve it by demoting most of the 13 easy TB1-clean tasks to the canary bench and pulling replacements from the extended pool's 27 hard / 66 medium.

**Budget compression (do this; it is the cheapest fidelity fix available).** For every TRAIN and PROBE task set `[agent].timeout_sec = clamp(expert_time_estimate_min × 60 / 10, 600, 1800)`, reproducing 2.1's median 10× expert:agent ratio. Where `expert_time_estimate_min` is missing in the TB1 metadata (it is, for many), substitute `junior_time_estimate_min / 3` or estimate it during the oracle validation run.

> This is a dev-set configuration choice and entirely legitimate. It must **not** be carried to the scored run: 2.1 forbids `timeout_multiplier ≠ 1.0` and any resource override, and errored trials score 0 without exclusion.

---

# 2. ITERATION DESIGN

## 2.1 Cost model

Per trial: mean agent wall ~700 s + container build/attach/verify ~120 s ≈ **13.7 min**. Concurrency 4 inside a **single** `harbor run` process (this satisfies the repo's bench discipline: one bench at a time, one MCP brain, ≤5 bench terminals — four in-process workers are one bench).

| Event | Shape | Trials | Wall @ conc 4 | Count over 137 iters | Total |
|---|---|---|---|---|---|
| Iteration | 8 tasks × 2 attempts | 16 | ~55 min + ~10 min lesson pass | 137 | **148 h** |
| TRAIN checkpoint | 49 × 1, every 10th iter | 49 | ~2.8 h | 13 | 36 h |
| PROBE | 20 × 5, every 20th iter | 100 | ~5.7 h | 6 | 34 h |
| SEAL | 12 × 5, twice only | 60 | ~3.4 h | 2 | 7 h |
| | | | | **≈ 225 h** | **≈ 9.4 days continuous** |

If that is too much, the honest reduction is **fewer, larger iterations**, not shorter ones: 6 tasks × 2 attempts × 100 iterations ≈ 165 h total. Do not drop to 1 attempt — the second attempt is what measures the consistency gap, which the audit identified as the largest teachable band (10–16 points, vs 3–5 for scaffold work).

## 2.2 Rotation policy

Each iteration draws **8 tasks** from TRAIN by slot, not by shuffle:

| Slot | n | Rule |
|---|---|---|
| **Deficit** | 3 | Sampled from TRAIN tasks whose primary tag ∈ {M, J, N, A, K-hard, F-grader-contract}, weighted by the 2.1 capability shares in §1 |
| **Replay** | 2 | Tasks that scored 0/2 in the last 3 iterations — highest-priority failures first |
| **Staleness** | 2 | Tasks not seen for the longest number of iterations |
| **Canary** | 1 | A trivially-passing easy task. If a canary ever fails, the harness is broken; halt and fix before interpreting anything else |

**Anti-memorisation cap:** no task may appear in more than one of any three consecutive iterations. Enforce in the sampler, assert in the run log.

**Quarantine:** after the first TRAIN checkpoint, any task with 0/2 across three separate iterations *whose failures classify as "deep derivation under budget"* moves to QUARANTINE and is sampled at most once per 40 iterations. These tasks burn ~14 min/trial and produce no transferable lesson (§5). Do not let them dominate the replay slot — that is the most likely way this loop wastes half its budget.

## 2.3 Per-iteration pipeline

1. **Select** 8 tasks by the slot rules.
2. **Run** `harbor run -p <dev-corpus-path> --n-attempts 2 -n 4 …` with the TerranSoul agent on the max rung, brain retrieval ON. *(Verify flag semantics with `harbor run --help` first — public docs disagree on whether `-k` is attempts or task limit, and `-n` is concurrency.)*
3. **Classify every failed trial** into the audit's two official taxonomies, automatically where possible and by judge pass otherwise:
   - trajectory level: Execution (*disobey specification / step repetition / unaware of termination*), Coherence (*reasoning–action mismatch / context loss / derailment*), Verification (*premature termination / no or incorrect verification / weak verification*);
   - command level: Invocation (35.1% of 2.1 command failures, of which *command-not-found on PATH* is 24.1%), REPL (19.1%), Runtime (15.5%), Filesystem (14.1%).
4. **Route by class — this is the step that decides where effort goes.**
   - Invocation / Filesystem / *command-not-found* → **scaffold backlog (S1, S8 in §5). Not a lesson.**
   - Verification class → **exit gate (S2/S5). Not a lesson**, unless the missed check is domain-shaped (then a lesson too).
   - Execution *disobey-specification*, Coherence → **candidate lesson**.
   - Runtime / REPL → triage individually.
5. **Draft ≤2 candidate lessons** per iteration in the §3 form.
6. **Purity gate (automated, blocking).** Reject any candidate lesson matching: any of the 89 scored task ids; any of the 241 `original-tasks` ids; any absolute path that occurs in exactly one dev task; any numeric literal that occurs in a dev task's test file. Build this deny-list programmatically from the corpus at build time — it is the AGI-purity grep gate applied to lessons.
7. **Contradiction sweep.** `brain_search` the WHEN clause first. If an existing lesson contradicts, do not add a second opinion — supersede with an explicit correction that names and dates the superseded lesson.
8. **Admission replay (mandatory).** Re-run the 1–2 trials that motivated the lesson **with the lesson present**. Require at least one 0→1 flip. A lesson that cannot flip the failure that motivated it is speculative and is rejected. (This is the repo's reproduce-first principle applied to teaching.)
9. **Ingest** via `brain_ingest_lesson` with `category` **always set** (a missing `category` spends earned-autonomy trust and the retry resets the cooldown), tags including the capability code and the iteration id.
10. **Snapshot** the lesson store (tag `mcp-data/shared/` + the live brain DB) with the iteration id, so any interval can be bisected and rolled back.

**Lesson budget.** Cap active retrievable lessons at ~120. Score each by utility = win rate on trials where it was actually retrieved. Retire any lesson with negative utility over ≥5 retrievals. An unbounded lesson store degrades retrieval precision, and precision is what makes the WHEN clause fire at the right moment.

**Ablation slot.** At every PROBE, also run PROBE with **brain retrieval disabled**. The difference is the only honest measurement of what teaching bought, as distinct from what scaffold changes bought during the same interval. Without this you will attribute S1–S8's gains to lessons.

## 2.4 Stopping rule

Measurement design first, because the rule is only as good as the statistic.

- PROBE = 20 tasks × 5 attempts = **100 trials**. Aggregate pass@1 across 20 tasks has a between-task standard error of ≈ **11 pp** — that component does **not** shrink with more attempts. An unpaired stopping rule tuned to 1–2 pp would be fitting noise.
- Therefore compare **paired**: same 20 tasks, same 5 seeds, PROBE(t) vs PROBE(t−1), using McNemar's exact test over the 100 seed-matched cells, α = 0.05. Pairing removes between-task variance. **MDE ≈ 8–10 pp.** State this number in the run log so nobody later over-reads a 3 pp move.
- If Harbor does not expose per-attempt seeds, pin sampling parameters and pair on (task, attempt-index); accept slightly wider intervals.
- Report alongside the aggregate: a **paired bootstrap CI** over (task, seed) cells, and the **per-capability delta table**. The per-capability table is what steers the next 20 iterations; the aggregate is only for the stopping decision.

Let ΔTRAIN = TRAIN pass@1 change between the checkpoints bracketing a PROBE interval; ΔPROBE = paired PROBE change; transfer ratio **τ = ΔPROBE / ΔTRAIN**.

**STOP when any of:**

- **(i) Overfit signature.** Two consecutive PROBE intervals where ΔTRAIN is significantly positive **and** ΔPROBE is not significant (McNemar p > 0.05). The loop has started memorising the training rotation. *This is the honest rule the brief asked for, made concrete.*
- **(ii) Transfer collapse.** Three consecutive intervals with τ < 0.3.
- **(iii) Plateau.** Two consecutive intervals with |ΔPROBE| below the MDE in both directions, with no scaffold change pending in the backlog.
- **(iv) Budget.** 137 iterations or the wall-clock cap, whichever first.

**TRIP-WIRE (not a stop — a rollback).** Any PROBE regression significant at p < 0.05: freeze the loop, roll the lesson store back to the last PROBE-best snapshot, and bisect the lessons added in that interval by re-running the regressed PROBE tasks with halves of the interval's lesson set. Regressions in a taught system are almost always one bad lesson firing too broadly, and the WHEN-clause discipline in §3 exists to make them findable.

---

# 3. WHAT A LESSON SHOULD LOOK LIKE

## 3.1 Required form

```
WHEN    <observable condition, checkable BEFORE acting, from the environment
         or the agent's own trajectory>
THEN    <action, check, or ordering constraint>
BECAUSE <mechanism — a property of systems of this kind, not of one task>
COST    <what applying it costs when it was not needed>
SCOPE   <the class of environments in which the condition can hold>
```

Hard rules, all mechanically checkable:

1. **The WHEN clause must be observable before the action.** "When the tests fail" is a *result*, not a trigger — it teaches nothing about when to act differently.
2. **A COST clause is mandatory.** A lesson with no cost fires everywhere and becomes a hardcoded decision. The cost is what lets the agent decline it.
3. **No proper nouns from the corpus.** No task ids, no fixture filenames, no path that exists in exactly one task, no expected value.
4. **Falsifiable BECAUSE.** "Because it works better" is not a mechanism. If the clause cannot be wrong, the lesson cannot be retired.
5. **The WHEN clause is the retrieval key.** It should contain the literal strings the agent will actually *see* — error-message shapes, tool names, config filenames — because that text is what gets embedded and matched at the moment the lesson is needed. A beautifully abstract WHEN clause that shares no tokens with the observation will never be retrieved. This is a retrieval-engineering constraint, not a style preference.

Map to the ingest payload: `content` = the five clauses; `category` ∈ {`reference`, `feedback`, `project`} (**always set it**); `tags` = capability code + condition keywords + iteration id; `importance` = 1–10, reserved ≥8 for lessons that flipped ≥2 distinct tasks.

## 3.2 Five good lessons (invented — none harvested from any task set)

**GOOD-1 (F, grader-environment contract)**
WHEN the repository's verification entry point constructs its own interpreter or virtual environment — a lockfile, a `uv`/`tox`/`nox`/`poetry` invocation, or a pinned requirements block written inside the test runner itself —
THEN install the code's runtime dependencies into *that* environment's resolution path, or make the code import-safe under the pinned versions, and verify by executing the test runner rather than by executing the code directly.
BECAUSE the process that grades you is not the process you developed in; a dependency that satisfies your interactive shell can be absent, or a different major version, inside the runner's environment, and the failure surfaces as an import error attributed to your code.
COST one extra invocation of the test runner, typically under a minute.
SCOPE any repository whose test entry point mentions an environment or dependency manager.

**GOOD-2 (Verification, universal)**
WHEN you are about to declare a task complete,
THEN re-read the original instruction, enumerate every noun that names an output — path, filename, port, format, field, permission — into an explicit checklist, and confirm each one against the filesystem and process table *as they are now*, not against your recollection of having created it.
BECAUSE later steps routinely overwrite, move, truncate, or restart the things earlier steps produced, and the grader observes only the final state of the container.
COST 30–90 seconds.
SCOPE every task.

**GOOD-3 (J/A, resource budget)**
WHEN a build or test command chooses its parallelism from CPU count and `nproc` reports 1 or 2, or the memory cgroup limit is at or below 2 GB,
THEN pin the job count to 1 and prefer incremental or partial targets over a full-tree build.
BECAUSE parallel jobs on a single core add scheduler and peak-memory pressure without adding throughput, and the resulting failure is an OOM kill or a timeout — both of which present as a compiler or test error and send you debugging the wrong thing.
COST a modest slowdown on a genuinely multi-core host.
SCOPE any container reporting low `nproc` or a low cgroup memory limit.

**GOOD-4 (M/K, numeric correctness)**
WHEN success is stated as a number compared against a tolerance, a threshold, or a "within X" phrase,
THEN locate the artifact that *defines* the comparison — the checker, the reference implementation, the schema, the fixture generator — and reproduce its exact reduction order, rounding, units, and dtype, rather than computing a mathematically equivalent quantity your own way.
BECAUSE stated tolerances are usually tighter than the spread between conventions: float accumulation order, degrees versus radians, sample versus population denominators, inclusive versus exclusive bounds, and 0- versus 1-based indexing each move the answer past the bound while leaving it plausible.
COST a few minutes of reading before computing.
SCOPE any task whose acceptance is a numeric comparison.

**GOOD-5 (B/E2, service liveness)**
WHEN the deliverable is a running service, daemon, or background process,
THEN start it detached from your shell session, then prove it from a *new* shell by exercising the exact request shape the instruction described — including the documented error cases — not merely by checking that the port is bound.
BECAUSE processes started in the foreground of an agent session terminate when that session ends, and "something is listening" does not imply "the endpoint answers with the documented status code and body shape."
COST one extra round trip per endpoint.
SCOPE any task naming a port, daemon, endpoint, or "must still be running."

## 3.3 Three bad lessons (invented) and why each fails

**BAD-1.** *"In the CSV merge task, the second file's header is offset by one column, so drop its first line before concatenating."*
Fails rule 3 outright: keyed to one task's fixture. It encodes an **answer**, not a method, so it evaporates the moment the fixture changes and teaches nothing about a task you have never seen. It would also be read as task-keyed injected guidance by the leaderboard's trajectory audit.

**BAD-2.** *"Always run `pip install --upgrade pip setuptools wheel` before installing anything."*
No WHEN clause and no COST clause, so it fires unconditionally — it is a hardcoded decision wearing a lesson's clothes. It spends time in every trial, and in a pinned or offline environment it actively breaks the resolution the grader depends on. A lesson the agent can never decline is a policy change, and policy changes belong in the scaffold where they can be measured and reverted, not in a memory store where they silently apply forever.

**BAD-3.** *"If the tests keep failing, the expected value is usually 42.0 — try writing that."*
Encodes a grader value rather than a derivation; has no falsifiable mechanism; and is textbook `task_level_reward_hacking` under the board's published rubric (hardcoding grader values, fabricating answers after abandoning real work). It is also self-reinforcing: the one trial where guessing worked will be recorded as confirmation, and a lesson that cannot be disconfirmed will never be retired by the utility filter.

---

# 4. HELD-OUT VALIDATION

Two held-out splits, because they answer different questions.

## PROBE — 20 tasks, opened every 20th iteration, never trained on

Selected to mirror the **2.1** capability mix (not the TB1 mix), with ≥2 tasks per deficit capability, and spanning easy→hard.

*TB1-clean (12):*
`organization-json-generator` (hard; G K L M) · `run-pdp11-code` (hard; F I K L) · `cartpole-rl-training` (hard; F J L M) · `build-linux-kernel-qemu` (medium; A D G H J) · `build-tcc-qemu` (medium; A G H K) · `conda-env-conflict-resolution` (medium; C F G I) · `intrusion-detection` (medium; G I K L) · `solana-data` (medium; B E1 E2 F G L) · `swe-bench-fsspec` (medium; C D K) · `grid-pattern-transform` (easy; K L M) · `heterogeneous-dates` (easy; K L M) · `new-encrypt-command` (easy; K L)

*Synthetic twins (8):* SYN-N2, SYN-M3, SYN-J2, SYN-A1', SYN-F1', SYN-V1', SYN-E1', SYN-K2 — each authored from the capability spec alone by a session that has not seen the TRAIN synthetics, and frozen before iteration 1.

**PROBE hygiene, enforced not assumed:**
- Never in the rotation, never in the replay slot, never used to author or debug a lesson, never used to tune the prompt or the scaffold.
- Trajectories from PROBE runs are written to a separate directory that the lesson-drafting step **cannot read**. This is the failure mode that quietly destroys held-out sets: an engineer reads a PROBE trajectory to understand a failure, and the split is gone.
- Re-run the exact-id and sibling-name filters against PROBE at every checkpoint — dev corpora drift when people add tasks.

## SEAL — 12 tasks, opened exactly twice

Drawn from the 21 **hard, clean, non-core** tasks in the extended pool, chosen because their category mix (software-engineering, mathematics, scientific-computing, model-training, machine-learning, security) matches the 2.1 hard tier, which the audit showed is where 25 of 30 hard tasks live. Candidate pool:

`3d-model-format-legacy` · `chem-property-targeting` · `hf-train-lora-adapter` · `lean4-proof` · `leelachess0-pytorch-conversion` · `magsac-install` · `neuron-to-jaxley-conversion` · `parallel-particle-simulator` · `parallelize-graph` · `rare-mineral-allocation` · `reverse-engineering` · `stable-parallel-kmeans` · `word2vec-from-scratch` · `causal-inference-r` · `chem-rf` · `find-official-code` · `movie-helper` · `vul-flink` · `install-windows-xp`\* · `port-compressor`\* · `play-zork-easy`\*

\* **excluded** — sibling-name collisions with scored tasks (`install-windows-3.11`, `write-compressor`) or with a TRAIN task (`play-zork`). Pick 12 from the remaining 18.

**Opened exactly twice:** once before iteration 1 (baseline), once at the go/no-go. Nobody reads SEAL trajectories in between. Any third opening invalidates it, and you should say so in the run log rather than pretend.

## Go/no-go before spending the 445-trial scored run

Require **all three**:

1. **SEAL pass@1** improved over baseline by ≥ the paired MDE, McNemar p < 0.05 on 60 seed-matched cells.
2. **SEAL consistency gap narrowed**: (pass@5 − pass@1) is smaller than at baseline. The audit measured this gap at 9–22 points across frontier models and identified it as the largest teachable band; if pass@1 rose without the gap narrowing, the gain probably came from luck or extra retries, not from capability, and it will not survive a different task set.
3. **Ablation is positive**: the retrieval-ON minus retrieval-OFF delta at the final PROBE is significantly > 0. If it is not, the improvement is scaffold work and the lesson store is not carrying its weight — ship the scaffold, and say plainly that the teaching loop did not contribute.

**Projecting dev → 2.1.** Do not quote a dev number as a 2.1 expectation. Project it: `Δ2.1 ≈ Σ_c w_c × Δ_c`, where `w_c` is the 2.1 capability share from §1 and `Δ_c` is the measured per-capability delta on SEAL/PROBE. Because the dev set over-represents C/H/E2 (already-solved capabilities) and under-represents M/J/N even after the synthetics, the naive aggregate will **overstate** 2.1 transfer. Publish the reweighted figure and the naive figure side by side.

---

# 5. WHAT TEACHING CANNOT FIX

**Blunt version: most of the addressable failure surface is harness, not knowledge. Plan the effort split accordingly — roughly 60% scaffold, 30% lessons, 10% corpus construction — and let the §2.3 ablation tell you if that was wrong.**

The audit bounded the three bands:

| Band | Size | Movable by |
|---|---|---|
| Never solved in 5 attempts | ~5–7 pts | Neither. A better student or more compute. |
| Solved *sometimes* (consistency gap) | **10–16 pts** | Mostly **scaffold** — discipline, gates, budget awareness. Some lessons. |
| Scaffold ceiling measured across submissions | 3–5 pts | Scaffold, and it is already partly claimed by existing harnesses. |

And the command-level distribution is decisive: **Invocation errors are 35.1% of all command failures, and *command-not-found on PATH* alone is 24.1%.** That is not a knowledge gap. A model does not need to be *taught* that `curl` might be absent; it needs a preflight step that *tells it* what is present. A lesson fixes this only in the trials where the lesson happens to be retrieved. A scaffold step fixes it in all 89. The benchmark's own maintainers agree with the diagnosis: their `tests/test.sh` runs `apt-get install -y curl` in **80 of 89 tasks** because they do not assume it exists either.

## 5.1 Scaffold work items — build these, do not teach them

| ID | Item | Fixes | Why not a lesson |
|---|---|---|---|
| **S1** | **Environment preflight probe.** On container entry, emit a capability manifest: base family, `nproc`, cgroup memory, free disk, interpreter versions and their site-packages roots, presence of `gcc/git/curl/make/pkg-config`, package manager, network reachability. Cache the *decision tree* (which of the two families am I in, and what does that family lack), not a literal inventory. | Invocation class 35.1%; command-not-found 24.1% | Two base families cover 85 of 89 tasks with median-11-line Dockerfile deltas — the probe is nearly free and always right. A lesson is retrieval-conditional. |
| **S2** | **Hard exit gate with a reserved verification window.** Reserve the last 12–15% of the budget; refuse to declare completion before the gate runs. The gate re-derives acceptance conditions *from the instruction text* and checks each against current container state. | Entire Verification class | This is deterministic control flow. Encoding it as a lesson makes it optional. |
| **S3** | **Budget observability.** Inject elapsed and remaining wall-clock into every turn, plus a reserve trip-wire. | Overrun → reward 0, errored trials not excluded | You cannot teach time-awareness to a model that has no clock. The audit found *no* correlation between episode count and success (r ≈ −0.03) — grinding has zero expected value, so the reserve is pure upside. |
| **S4** | **Step ledger + repetition detector.** Persist a stage ledger to disk; detect and interrupt repeated identical actions and post-summarisation context loss. | Execution *step repetition*, *unaware of termination*; Coherence *context loss*, *derailment* | These are the dominant trajectory-level failures for frontier models, and they are all state-management problems. |
| **S5** | **Grader-environment simulator.** Before declaring done, execute the task's own test entry point in a clean environment, not the agent's shell. | The 83/89 pinned-venv contract; `module not found` 8.3% | The whole point is that the agent's environment is not the grader's — you cannot introspect your way out of that, you have to run it. |
| **S6** | **Environment-damage guard.** At exit: `apt-get update` works, DNS resolves, TLS imports, free disk above threshold, `PWD != /`, no dangling system symlinks. | 80/89 graders install packages after the agent stops; 87/89 abort on `PWD == /` | Correct work plus a broken box scores identically to no work. |
| **S7** | **Idempotent retry + rollback of destructive edits.** Snapshot before any operation that overwrites or deletes; make retries safe. | Filesystem class 14.1%; SYN-V1's whole failure mode | |
| **S8** | **Non-interactive defaults at the tool layer.** `DEBIAN_FRONTEND=noninteractive`, `--yes`/`--no-input`/`--batch`, stdin from `/dev/null`, PTY only when explicitly wanted. | Interactive-hang stalls | The model already knows this; the harness should make forgetting impossible. |

## 5.2 What is neither — the hard floor

The **~5–7% never solved in five attempts** is deep algorithmic or numeric derivation under a 1-CPU / 2 GB / 900 s budget, from an under-specified instruction. The audit's empirical ordering puts M at rank 58.7 and J at 54.5 against a 44.0 baseline, and the bottom-10 tasks are spec-inference 9/10 and numeric-correctness 6/10, with 9 of 10 on a single CPU. No lesson moves this and no scaffold moves it. **Do not spend iterations there** — that is what the QUARANTINE bucket in §2.2 is for. The one legitimate partial mitigation is budget triage: recognising early that a task is in this class and spending the remaining budget on a partial-but-correct artifact is worthless under all-or-nothing scoring, so the correct move is to spend it on the *verification* of whatever was achieved, in case the derivation was right and only the serialisation was wrong.

## 5.3 What lessons are genuinely for

The residue after S1–S8, which is real but smaller than people expect:

- **Execution / disobey-specification** — re-reading and decomposing an instruction into checkable clauses, resisting the plausible-but-unrequested action. Genuine judgement, genuinely teachable.
- **K / spec inference** — knowing *which artifact defines the acceptance criterion* and going to read it (GOOD-4). Partly harness (make the artifacts easy to find), substantially judgement.
- **Convention traps in M** — the specific knowledge that tolerances are tighter than convention spreads.
- **Coherence under long sequences** — after S4 gives the agent a ledger, using it well.

And the sharpest instruction for whoever runs this loop: **the dev set as shipped over-weights exactly the capabilities the student already has.** C at ratio 3.06, H at 1.95, E2 at 1.78 — debugging a given failure, driving an interactive console, bringing a service up — are empirical ranks 22.8, 37.8 and 30.5, i.e. the *easiest* band in the whole benchmark. Without the §1.1 synthetics and the §1.2 rebalance, roughly a third of ~137 iterations goes to teaching what is already known, and the loop will still show a rising TRAIN curve while PROBE flatlines. That is precisely the overfit signature the stopping rule in §2.4 is built to catch — but it is much cheaper to not build the corpus that way in the first place.

---

**Sources:** [terminal-bench-2-1](https://github.com/harbor-framework/terminal-bench-2-1) · [terminal-bench (core@0.1.1 registry + original-tasks)](https://github.com/harbor-framework/terminal-bench) · [Terminal-Bench paper, arXiv 2601.11868](https://arxiv.org/abs/2601.11868) · [Running Terminal-Bench 2.1 with Harbor](https://www.tbench.ai/docs/run-terminal-bench-2-1) · [Harbor: Creating Tasks](https://deepwiki.com/harbor-framework/harbor/2.4-creating-tasks) · [Harbor: task CLI](https://deepwiki.com/harbor-framework/harbor/10.3-harbor-tasks) · [Harbor: differences from Terminal-Bench](https://harborframework.com/docs/tasks/task-difference) · [Harbor datasets](https://harborframework.com/docs/datasets)

**Working files (scratchpad, safe to delete):** `C:\Users\DevStar\AppData\Local\Temp\claude\D--Git-TerranSoulApp\5d5a8a67-dbb7-472a-9c6e-229b8009ba83\scratchpad\` — `tb1/` (terminal-bench clone), `tb21/` (2.1 clone), `tb1_clean.json` (43 clean core@0.1.1 tasks + metadata), `covmap.py` (coverage-map generator, contains the dev capability tagging), `handtag.json` / `tb21_meta.json` (audit-phase 2.1 tags and metadata).

**MCP receipt:** `brain_*` tools are not exposed to this subagent process, so no `brain_search` / `brain_suggest_context` receipt can be produced for this phase. Recording as a blocker rather than skipping silently. The lessons produced by the loop this document specifies must be ingested through `brain_ingest_lesson` (always with `category` set) and synced to `mcp-data/shared/seed-lessons.sql`.