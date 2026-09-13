#!/usr/bin/env bash
# Merge every batch job of a sweep into one honest result.
#
#   usage: merge-sweep.sh <jobs-dir> [prefix ...]
#          merge-sweep.sh <jobs-dir>            # reads mcp-data/.tb-sweep-prefixes.txt
#
# "Honest" means the things this project has already been burned by:
#
#   * ERRORED TRIALS ARE SCORED 0, NEVER DROPPED (leaderboard/SUBMIT.md). A trial
#     that died with UnknownApiError still reported reward 1.0 on job
#     dg-20260804-161447, because the verifier ran regardless of the agent
#     erroring. Both figures are printed: the official one scores errors 0, the
#     diagnostic one excludes them to show how much of a gap is infrastructure.
#   * BOTH SHAPES, CORRECTLY LABELLED. This bullet used to read "The leaderboard
#     reports per-TASK, so trials are collapsed per task first" — FALSE, checked
#     2026-08-12 against leaderboard/src/leaderboard/core/metrics.py:37, which is
#     `accuracy = 100.0 * successful / total` over TRIALS. The operational concern
#     behind the old wording is real (a restart that re-runs one task reweights a
#     per-trial mean toward that task), but the answer is to DISCLOSE unequal k,
#     not to publish a different quantity under the leaderboard's name. Both the
#     per-trial Accuracy and the per-task solve rate are printed and named.
#   * EVERY PREFIX, NOT THE LAST ONE. Each restart of run-sweep.sh mints a new
#     TB_JOB_PREFIX. Merging only the final prefix published a number computed
#     from 1 job out of 56 — measured 2026-08-05, when the four live prefixes
#     scored 0.857 / 0.790 / 0.500 / 0.000 depending on which you happened to
#     pick. A prefix-LESS merge is equally wrong in the other direction: it
#     sweeps in probes and aborted runs. So prefixes are explicit and plural.
#   * NO VERDICT WITHOUT COVERAGE. "BEATS THE BAR" once fired off a single
#     trial. It now refuses to render until the run is actually comparable.
#   * BRAIN USAGE IS COUNTED FROM THE PROXY LOG ONLY. The job dir duplicates
#     each tool_use across trajectory.json and the session jsonl, so grepping it
#     double-counts. See check-terransoul-used.sh.
set -uo pipefail

# Python here writes report text containing non-ASCII glyphs (arrows, +/-).
# Windows Python defaults stdout to cp1252, so an un-guarded run either CRASHES
# mid-report (self-improve-rate.sh died with UnicodeEncodeError after printing
# only its first line) or emits mojibake (attempt-uplift.sh printed a literal
# replacement char). merge-sweep.sh produces the HEADLINE NUMBER, so a crash
# there truncates the very result the campaign exists to report. The sweep
# drivers inherit this from run-parallel.sh, but not when run standalone.
export PYTHONIOENCODING=utf-8 PYTHONUTF8=1
JOBS="${1:?usage: merge-sweep.sh <jobs-dir> [prefix ...]}"
shift || true
PREFIXES=("$@")

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
PREFIX_FILE="$REPO/mcp-data/.tb-sweep-prefixes.txt"
ACCEPTED_FILE="$REPO/mcp-data/.tb-sweep-accepted-failures.txt"

# ── THE QUARANTINE IS DERIVED, NOT TRUSTED ───────────────────────────────
# `$REPO/mcp-data/.tb-sweep-quarantine.txt` is a FIXED SHARED PATH, and this
# machine runs several agent sessions at once. A merge that simply read that
# file would inherit whatever the last writer put there — and the dangerous
# direction is silent: a scan of a DIFFERENT cohort overwrites it with a
# shorter list, and a tainted trial in THIS cohort quietly stops being
# quarantined. Nothing in the output would look wrong.
#
# So recompute it here, from this jobs dir, into a merge-scoped temp file.
# TB_QUARANTINE_FILE still overrides (the test suite uses it), and the shared
# file is used only if the scanner is missing.
QUARANTINE_FILE="${TB_QUARANTINE_FILE:-}"
if [ -z "$QUARANTINE_FILE" ]; then
  if [ -f "$HERE/integrity-scan.py" ]; then
    QUARANTINE_FILE="$(mktemp)"
    python "$HERE/integrity-scan.py" "$JOBS" --write "$QUARANTINE_FILE" >/dev/null 2>&1
    trap 'rm -f "$QUARANTINE_FILE"' EXIT
  else
    echo "merge-sweep: integrity-scan.py missing — falling back to the shared quarantine file," >&2
    echo "  which may have been written by another session against another cohort." >&2
    QUARANTINE_FILE="$REPO/mcp-data/.tb-sweep-quarantine.txt"
  fi
fi

if [ "${#PREFIXES[@]}" -eq 0 ] && [ -f "$PREFIX_FILE" ]; then
  while IFS= read -r line; do
    [ -n "$line" ] && PREFIXES+=("$line")
  done < <(sort -u "$PREFIX_FILE")
fi

if [ "${#PREFIXES[@]}" -eq 0 ]; then
  echo "merge-sweep: refusing to merge without a prefix." >&2
  echo "  A prefix-less merge mixes probes and aborted runs into the number." >&2
  echo "  Pass them explicitly, or write one per line into $PREFIX_FILE" >&2
  exit 2
fi

# ── IDENTITY-BLIND POOLING, closed 2026-08-12 ────────────────────────────
# harbor keys every eval bucket as `<agent>__<model>__<dataset>` — the same
# fact redo-task.sh's own comments have warned about since 2026-08-08 for its
# OWN identity inheritance, but this script's aggregation never checked it.
# Measured: 3 filter-js-from-html trials ran under agent=claude-code,
# model=claude-opus-5 (a different session's ad-hoc run) and got pooled into
# this cohort's "solved-if-any" bucket right alongside the correctly-keyed
# terransoul:TerranSoul/claude-sonnet-5 trials, none of which ever passed —
# so the task read SOLVED for a model that never solved it. The real
# leaderboard's `lb filter` would never merge these (it splits by exactly
# this tuple); a local number that does is not the number that could ever be
# submitted.
#
# Filter ONLY when a launch file identifies the cohort — so a test fixture
# with a synthetic eval key and no launch file behaves exactly as before.
IDENTITY_PREFIX=""
LAUNCH="${TB_LAUNCH_REF:-$REPO/mcp-data/.tb-par0.launch}"
if [ -f "$LAUNCH" ]; then
  ID_AGENT="${TB_AGENT:-$(tr ' ' '\n' < "$LAUNCH" | sed -n 's/^TB_AGENT=//p' | head -1)}"
  ID_MODEL="${TB_MODEL:-$(tr ' ' '\n' < "$LAUNCH" | sed -n 's/^TB_MODEL=//p' | head -1)}"
  # harbor's eval key uses only the part of the agent name BEFORE the first
  # ':' — TB_AGENT is the CLI value "terransoul:TerranSoul" (agent:variant),
  # but the eval key segment is plain "terransoul". Measured live 2026-08-12:
  # building the prefix from the raw TB_AGENT value matched NOTHING and
  # excluded the entire correctly-identified cohort (0/89 tasks) — the exact
  # kind of silent-in-the-wrong-direction failure this fix must not have.
  ID_AGENT="${ID_AGENT%%:*}"
  # ⛔ AND HARBOR ALSO NORMALISES `_` TO `-`. THIS IS THE SAME BUG AGAIN.
  #
  # The fix above handled the colon and stopped there. The live launch file
  # carries `TB_AGENT=terransoul_hook:TerranSoulHook`, which yields
  # `terransoul_hook__claude-opus-5__` — but the eval keys harbor actually
  # wrote are `terransoul-hook__claude-opus-5__tasks`, with a HYPHEN.
  #
  # MEASURED 2026-09-01 across the 266 job dirs under `jobs/`:
  #     238  claude-code__claude-opus-5__tasks
  #      14  terransoul-hook__claude-opus-5__tasks     <- hyphen
  #       1  terransoul__claude-sonnet-5__terminal-bench/terminal-bench-2-1
  #       1  oracle__tasks
  # ZERO keys carry the underscore form, so `startswith()` was false for every
  # trial the current launcher produces and the filter excluded 100% of the
  # cohort — reported as "0 of 0 trials" and "ACCURACY 0.00%", which reads like
  # an empty corpus rather than a broken filter. Exactly the
  # "silent-in-the-wrong-direction" failure the comment above says this must
  # not have.
  #
  # BOTH FORMS ARE ACCEPTED rather than replacing one with the other. The
  # normalisation is harbor's and undocumented here; matching either cannot
  # re-introduce the total-exclusion failure, while still rejecting genuinely
  # different agents (`claude-code`, `oracle`) which is the filter's actual job.
  ID_AGENT_ALT="$(printf '%s' "$ID_AGENT" | tr '_' '-')"
  if [ -n "$ID_AGENT" ] && [ -n "$ID_MODEL" ]; then
    IDENTITY_PREFIX="${ID_AGENT}__${ID_MODEL}__"
    if [ "$ID_AGENT_ALT" != "$ID_AGENT" ]; then
      IDENTITY_PREFIX_ALT="${ID_AGENT_ALT}__${ID_MODEL}__"
    fi
  fi
fi
if [ -n "$IDENTITY_PREFIX" ]; then
  if [ -n "${IDENTITY_PREFIX_ALT:-}" ]; then
    echo "  identity filter    : $IDENTITY_PREFIX* or $IDENTITY_PREFIX_ALT*  (from $LAUNCH; TB_IDENTITY_FILTER=0 to disable)"
  else
    echo "  identity filter    : $IDENTITY_PREFIX*  (from $LAUNCH; TB_IDENTITY_FILTER=0 to disable)"
  fi
fi

TASKS_EXPECTED="${TB_TASKS_EXPECTED:-89}" \
TRIALS_REQUIRED="${TB_ATTEMPTS:-1}" \
ACCEPTED_FILE="$ACCEPTED_FILE" \
QUARANTINE_FILE="$QUARANTINE_FILE" \
IDENTITY_FILTER_ENABLED="${TB_IDENTITY_FILTER:-1}" \
IDENTITY_PREFIX="$IDENTITY_PREFIX" \
IDENTITY_PREFIX_ALT="${IDENTITY_PREFIX_ALT:-}" \
python - "$JOBS" "${PREFIXES[@]}" <<'PY'
import json, os, sys, glob
from collections import defaultdict

jobs_dir = sys.argv[1]
prefixes = sys.argv[2:]
expected = int(os.environ.get("TASKS_EXPECTED", "89"))
required_k = int(os.environ.get("TRIALS_REQUIRED", "1"))
accepted_file = os.environ.get("ACCEPTED_FILE", "")
quarantine_file = os.environ.get("QUARANTINE_FILE", "")
identity_filter_on = os.environ.get("IDENTITY_FILTER_ENABLED", "1") == "1"
identity_prefix = os.environ.get("IDENTITY_PREFIX", "")
# harbor normalises `_` to `-` in the agent segment, so accept EITHER form.
# A launch file written with an underscore otherwise excludes the whole
# cohort silently — measured 2026-09-01: 100% excluded, reported as
# "0 of 0 trials" and "ACCURACY 0.00%", which reads like an empty corpus.
identity_prefixes = tuple(
    p for p in (identity_prefix, os.environ.get("IDENTITY_PREFIX_ALT", "")) if p
)

# ── COST FALLBACK: RECONSTRUCT FROM RAW TOKEN USAGE, closed 2026-08-18 ──────
# The comment above (2026-08-08) fixed jobs still in flight and permanently
# barren jobs. It did NOT fix the remaining gap: a job that DID run trials but
# whose result.json genuinely never got a `cost_usd` field written (harbor
# died between finishing the trial and stamping final stats). That job's real
# spend was previously counted only in `cost_missing` — a counter, not a
# dollar figure — so it silently never reached the printed total. Before
# giving up on such a job, reconstruct its cost from the same raw
# trial-transcript `usage` blocks attempt-cost.sh already scans (trial_tokens()
# in this directory) — every assistant-turn JSONL record here carries its own
# `message.model` alongside `message.usage`, so this prices per-record instead
# of assuming one model for the whole job (a job can legitimately mix models
# across retries with different TB_MODEL launches).
#
# PRICING is Anthropic first-party LIST rate (see `claude-api` skill's cached
# model table) for the models this campaign has actually launched under
# (TB_MODEL as read elsewhere in this script). It is NOT this org's billed
# rate if a volume/negotiated discount applies, and NOT Claude Sonnet 5's
# temporary introductory rate ($2/$10 through 2026-08-31) some of this
# cohort's jobs may have billed at — so a recovered figure is a reasonable
# reconstruction, not an exact bill. Cache-read/write multipliers are
# Anthropic's documented formula (read ~0.1x input, 5m write 1.25x input, 1h
# write 2x input) — Anthropic does not publish per-model cache rates
# separately from the input rate, so this is the same formula applied to
# every model rather than model-specific published numbers.
PRICING = {
    "claude-sonnet-5":   {"input": 3.00, "output": 15.00},
    "claude-sonnet-4-6": {"input": 3.00, "output": 15.00},
    "claude-opus-5":     {"input": 5.00, "output": 25.00},
    "claude-opus-4-8":   {"input": 5.00, "output": 25.00},
    "claude-opus-4-7":   {"input": 5.00, "output": 25.00},
    "claude-haiku-4-5":  {"input": 1.00, "output": 5.00},
}
for _p in PRICING.values():
    _p["cache_read"] = _p["input"] * 0.1
    _p["cache_write_5m"] = _p["input"] * 1.25
    _p["cache_write_1h"] = _p["input"] * 2.0


def recover_job_cost(job_dir):
    """Reconstruct a job's cost_usd from its raw trial-transcript token usage.

    Same .jsonl `usage` scan as attempt-cost.sh's trial_tokens() (walk every
    .jsonl under the job dir, filter lines containing '"usage"', parse JSON),
    extended to also read each record's own `message.model` so per-model
    pricing and the cache_creation 5m/1h split (both present in the same
    trajectory schema attempt-cost.sh reads) are used instead of a single
    guessed rate.

    Returns (recovered_usd_or_None, unpriced_model_or_None):
      * (None, None)        -- no usage data found anywhere: fully barren
                                before any output, genuinely unrecoverable.
      * (usd, None)         -- every usage record was under a priced model;
                                `usd` is trustworthy.
      * (usd, model_name)   -- at least one usage record named a model this
                                script has no price for. `usd` covers only the
                                priced portion, so the caller must NOT add it
                                to the total silently — an under-priced
                                partial figure is worse than an honest
                                exclusion.
    """
    totals = defaultdict(lambda: {"out": 0, "in": 0, "cache_read": 0, "cache_1h": 0, "cache_5m": 0})
    found_any = False
    unpriced_model = None
    for root, _dirs, files in os.walk(job_dir):
        for f in files:
            if not f.endswith(".jsonl"):
                continue
            try:
                fh = open(os.path.join(root, f), encoding="utf-8", errors="replace")
            except OSError:
                continue
            with fh:
                for ln in fh:
                    if '"usage"' not in ln:
                        continue
                    try:
                        rec = json.loads(ln)
                    except Exception:
                        continue
                    msg = rec.get("message") or {}
                    u = msg.get("usage") if isinstance(msg, dict) else None
                    if not isinstance(u, dict) or not u:
                        u = rec.get("usage") or {}
                    if not isinstance(u, dict) or not u:
                        continue
                    found_any = True
                    model = (msg.get("model") if isinstance(msg, dict) else None) or rec.get("model")
                    if model not in PRICING:
                        unpriced_model = unpriced_model or (model or "<unknown>")
                        continue
                    t = totals[model]
                    t["out"] += u.get("output_tokens", 0) or 0
                    t["in"] += u.get("input_tokens", 0) or 0
                    t["cache_read"] += u.get("cache_read_input_tokens", 0) or 0
                    cc = u.get("cache_creation") or {}
                    if isinstance(cc, dict) and (cc.get("ephemeral_1h_input_tokens") or cc.get("ephemeral_5m_input_tokens")):
                        t["cache_1h"] += cc.get("ephemeral_1h_input_tokens", 0) or 0
                        t["cache_5m"] += cc.get("ephemeral_5m_input_tokens", 0) or 0
                    else:
                        # No 5m/1h split reported -- price the (usually small)
                        # remainder at the cheaper 5m (default TTL) rate so an
                        # unknown split does not overstate the reconstruction.
                        t["cache_5m"] += u.get("cache_creation_input_tokens", 0) or 0
    if not found_any:
        return None, None
    usd = 0.0
    for model, t in totals.items():
        p = PRICING[model]
        usd += t["out"] / 1_000_000 * p["output"]
        usd += t["in"] / 1_000_000 * p["input"]
        usd += t["cache_read"] / 1_000_000 * p["cache_read"]
        usd += t["cache_5m"] / 1_000_000 * p["cache_write_5m"]
        usd += t["cache_1h"] / 1_000_000 * p["cache_write_1h"]
    return usd, unpriced_model


def trial_agent_produced_work(job_dir, trial_id):
    """Did an ungraded-exception trial's agent produce work? Read-only mirror of
    terransoul_hook.py's `_agent_produced_work` (TBENCH-LATE-API-RETRY-1): same
    three evidence sources, same order, but read from the trial's own files
    here instead of imported from the hook (this script has no harbor result
    object to inspect, only what is on disk under `job_dir/trial_id/`).

    Returns (worked: bool, evidence: str). `worked=False` is the
    `reference_run_that_never_happened_is_not_a_failure` case the campaign has
    so far only applied BY HAND (root-cause-findings-2026-09-07.md §26,
    commit f9dccd98): zero tokens, no model turn anywhere -- a trial that
    never happened is not a failure, so it must not silently become one by
    sitting in exception_stats with nothing to grade.
    """
    trial_dir = os.path.join(job_dir, trial_id)
    if not os.path.isdir(trial_dir):
        # Not even the trial directory survived -- e.g. a preserved failed
        # attempt that was later cleaned up. No evidence of any kind exists.
        return False, "trial directory not found under this job"
    # 1. agent_result.n_output_tokens, from the trial's OWN result.json --
    #    harbor's parse of the transcript, populated even on a failed exit.
    try:
        with open(os.path.join(trial_dir, "result.json"), encoding="utf-8", errors="replace") as fh:
            r = json.load(fh)
        tokens = (r.get("agent_result") or {}).get("n_output_tokens")
        if tokens:
            return True, f"{tokens} output tokens in agent_result"
    except Exception:
        pass
    # 2. the host-side capture sidecar (`.terransoul-exec-failure.json`),
    #    written from the RAW stdout of a failed agent command -- independent
    #    of `docker cp`, which is exactly what could not run during a host
    #    spawn outage.
    try:
        with open(os.path.join(trial_dir, "agent", ".terransoul-exec-failure.json"), encoding="utf-8", errors="replace") as fh:
            rows = json.load(fh)
        turns = max((int(row.get("assistant_turns") or 0) for row in rows if isinstance(row, dict)), default=0)
        if turns > 0:
            return True, f"{turns} model turn(s) in the host-side capture"
    except Exception:
        pass
    # 3. an `agent` step in trajectory.json.
    try:
        with open(os.path.join(trial_dir, "agent", "trajectory.json"), encoding="utf-8", errors="replace") as fh:
            traj = json.load(fh)
        steps = (traj or {}).get("steps") or []
        agent_steps = sum(1 for s in steps if isinstance(s, dict) and s.get("source") == "agent")
        if agent_steps:
            return True, f"{agent_steps} agent step(s) in trajectory.json"
    except Exception:
        pass
    return False, "no output tokens, no model turn in the host capture, no agent step in the trajectory"


trials = defaultdict(list)   # task -> [(reward, errored, exception)]
off_identity = defaultdict(set)   # eval key -> {task ids pooled OUT}
# TBENCH-LATE-API-RETRY-1 / TBENCH-HOST-SPAWN-WAIT-1 (terransoul_hook.py): a
# trial can now land in exception_stats WITH a reward_stats entry (the retry
# refused to re-run it because the agent had already produced work — the
# exception is provenance, the grade stands) or WITHOUT one (a never-ran
# re-attempt's failed predecessor, or any other exception that pre-empted the
# verifier). `trials` above only ever sees the first kind, because it is built
# by walking reward_stats — the second kind has no entry to walk.
#
# THE GAP THIS LEFT: an ungraded-exception trial that was a task's ONLY trial
# in a k=1 sweep never entered `trials` at all, so the task vanished from
# `n_tasks`/`per_task_official` instead of scoring 0 -- SUBMIT.md's rule is
# that an errored trial is a 0 that STAYS in the denominator, and a task
# missing from the denominator entirely inflates the percentage further than
# scoring it 0 would. But not every ungraded exception is a real failure:
# root-cause-findings-2026-09-07.md §26 (commit f9dccd98) hand-applied
# `reference_run_that_never_happened_is_not_a_failure` to a proven NON-RUN
# (zero tokens, no agent step) -- that one trial is correctly EXCLUDED, not
# scored. `trial_agent_produced_work` (above) makes that same call in code,
# splitting ungraded exceptions into two buckets instead of one:
graded_exceptions = []      # (task, exception, reward, trial_id) -- graded despite the exception
errored_ran_ungraded = []   # (task, exception, trial_id, evidence) -- ungraded, but the agent ran: enters `trials` as a real 0
non_run_exceptions = []     # (task, exception, trial_id, evidence) -- ungraded AND never ran: excluded, per §26's precedent
cost = 0.0
barren_cost = 0.0            # spend by jobs that produced no trial at all
barren_jobs = 0
cost_missing = 0             # jobs whose result.json carried no cost_usd (before fallback)
cost_recovered_usd = 0.0     # of cost_missing, $ reconstructed from raw token usage
cost_recovered_jobs = 0      # of cost_missing, how many jobs the reconstruction covered
cost_unrecoverable_jobs = 0  # of cost_missing, how many stayed excluded from `cost`
unrecoverable_reasons = []   # (job_dir, reason) for the jobs above
seen_jobs = 0
unreadable = []
seen_paths = set()

for prefix in prefixes:
    for rj in sorted(glob.glob(os.path.join(jobs_dir, prefix + "*", "result.json"))):
        if rj in seen_paths:
            continue
        seen_paths.add(rj)
        try:
            with open(rj, encoding="utf-8", errors="replace") as fh:
                d = json.load(fh)
        except Exception as exc:
            # A job that cannot be parsed must NOT vanish silently — that is a
            # job's worth of result quietly leaving the denominator.
            unreadable.append((rj, str(exc)[:80]))
            continue
        stats = d.get("stats") or {}
        evals = stats.get("evals") or {}
        # COST IS BILLED WHETHER OR NOT THE JOB PRODUCED A TRIAL. Accumulate it
        # BEFORE the evals check: a job that dies before its first trial still
        # spent real money, and skipping it here dropped that spend from a figure
        # labelled "all jobs".
        #
        # Measured 2026-08-08: a merge reporting "$108.36 (all jobs)" sat against
        # $120.98 summed over every readable result.json — a $12.62 gap across 16
        # jobs. MOST of that gap was jobs still IN FLIGHT (harbor writes
        # result.json at job start and fills evals as trials finish), so it closed
        # on its own as they completed, and the steady-state understatement is
        # smaller than that number suggests. The durable defect is the permanently
        # barren job — one that errors out before any trial — whose cost vanished
        # silently. Both are now counted, and barren spend is reported separately
        # so an in-flight snapshot cannot be mistaken for waste.
        c = stats.get("cost_usd")
        cost_this_job = 0.0   # whatever got added to `cost` for THIS job, from
                               # either source -- kept so the barren-job
                               # breakdown below (a subset of `cost`) stays
                               # consistent even when the source was recovery,
                               # not result.json. A barren job (died before any
                               # scored trial) can still have spent real tokens
                               # and be missing cost_usd at the same time.
        if isinstance(c, (int, float)):
            cost_this_job = c
            cost += c
        else:
            cost_missing += 1
            recovered, unpriced = recover_job_cost(os.path.dirname(rj))
            if recovered is not None and unpriced is None:
                cost_this_job = recovered
                cost += recovered
                cost_recovered_usd += recovered
                cost_recovered_jobs += 1
            else:
                cost_unrecoverable_jobs += 1
                if recovered is None:
                    unrecoverable_reasons.append((rj, "no usage data in any trial transcript"))
                else:
                    unrecoverable_reasons.append((rj, f"usage recorded under unpriced model {unpriced!r}"))
        if not evals:
            if cost_this_job > 0:
                barren_cost += cost_this_job
            barren_jobs += 1
            continue
        seen_jobs += 1
        for eval_key, ev in evals.items():
            # IDENTITY-BLIND POOLING, closed 2026-08-12. `eval_key` is harbor's
            # own `<agent>__<model>__<dataset>` tuple. Without this check a
            # trial run under any agent/model silently joined THIS cohort's
            # solved-if-any bucket — measured: 3 filter-js-from-html trials run
            # under agent=claude-code/model=claude-opus-5 got pooled into a
            # cohort declared terransoul:TerranSoul/claude-sonnet-5, and the
            # task read SOLVED for a model that had a 0-of-5 record under its
            # own identity. `lb filter` on the real leaderboard would never
            # merge these; this pool must not either.
            if identity_filter_on and identity_prefixes and not eval_key.startswith(identity_prefixes):
                for score, ids in ((ev.get("reward_stats") or {}).get("reward") or {}).items():
                    for t in ids:
                        off_identity[eval_key].add(t.rsplit("__", 1)[0])
                continue
            bad = {}
            for exc, ids in (ev.get("exception_stats") or {}).items():
                for t in ids:
                    bad[t] = exc
            reward_lookup = {}
            for score, ids in ((ev.get("reward_stats") or {}).get("reward") or {}).items():
                for t in ids:
                    task = t.rsplit("__", 1)[0]
                    trials[task].append((float(score), t in bad, bad.get(t), t))
                    reward_lookup[t] = float(score)
            # TBENCH-LATE-API-RETRY-1 / TBENCH-HOST-SPAWN-WAIT-1: split `bad`
            # (every trial id exception_stats named, whether or not it was
            # graded) against `reward_lookup` (every trial id reward_stats
            # named, built above from the SAME eval so the two line up). A
            # trial in both is the "graded despite the exception" case the
            # retry hook now leaves standing; a trial only in `bad` is one
            # that never reached the verifier at all -- and THAT is split
            # again, by whether the agent actually ran (see
            # `trial_agent_produced_work` and the comment above `trials`).
            for t, exc in bad.items():
                task = t.rsplit("__", 1)[0]
                if t in reward_lookup:
                    graded_exceptions.append((task, exc, reward_lookup[t], t))
                    continue
                worked, evidence = trial_agent_produced_work(os.path.dirname(rj), t)
                if worked:
                    # The agent ran; the exception pre-empted the verifier
                    # only, not the attempt. SUBMIT.md: still a 0, still in
                    # the denominator -- exactly like any other errored trial,
                    # just with no verifier score to read a reward from.
                    trials[task].append((0.0, True, exc, t))
                    errored_ran_ungraded.append((task, exc, t, evidence))
                else:
                    non_run_exceptions.append((task, exc, t, evidence))

# ── INTEGRITY QUARANTINE ─────────────────────────────────────────────────
# A trial that reached the BENCHMARK'S OWN oracle solution / grading tests did
# not solve the task, whatever its verifier said, so it is forced to 0.0 here.
# Produced by integrity-scan.py; see that file for the 2026-08-08 build-pov-ray
# incident that motivated it. Scoring-side ONLY: the agent never sees this, so
# it can be enabled mid-sweep without breaking cohort uniformity.
quarantine = set()
if quarantine_file and os.path.exists(quarantine_file):
    with open(quarantine_file, encoding="utf-8", errors="replace") as fh:
        quarantine = {ln.strip() for ln in fh if ln.strip()}
quarantined_rows = []
if quarantine:
    for task, rows in trials.items():
        for i, (score, err, exc, tid) in enumerate(rows):
            if tid in quarantine:
                quarantined_rows.append((task, tid, score))
                rows[i] = (0.0, err, exc, tid)

accepted = set()
if accepted_file and os.path.exists(accepted_file):
    with open(accepted_file, encoding="utf-8", errors="replace") as fh:
        accepted = {ln.strip() for ln in fh if ln.strip()}

# ── collapse to ONE ROW PER TASK ─────────────────────────────────────────
# Official (SUBMIT.md): a task is solved if any trial scored 1.0; an errored
# trial is a 0, not an absence. A task whose every attempt errored is therefore
# a 0 that stays in the denominator — dropping it is what inflates a score.
per_task_official, per_task_diag = {}, {}
errored_rows, all_errored_tasks = [], []
for task, rows in sorted(trials.items()):
    clean = [r for r, e, _, _ in rows if not e]
    per_task_official[task] = 1.0 if any(r >= 1.0 for r, e, _, _ in rows if not e) else 0.0
    if clean:
        per_task_diag[task] = 1.0 if max(clean) >= 1.0 else 0.0
    else:
        all_errored_tasks.append(task)
    for r, e, exc, _tid in rows:
        if e:
            errored_rows.append((task, exc or "?"))

n_tasks = len(per_task_official)
off = sum(per_task_official.values()) / n_tasks if n_tasks else 0.0
diag = sum(per_task_diag.values()) / len(per_task_diag) if per_task_diag else 0.0
n_trials = sum(len(v) for v in trials.values())

# TBENCH-LATE-API-RETRY-1 / TBENCH-HOST-SPAWN-WAIT-1: `len(errored_rows)` (the
# figure this line printed before the non-run split below) is now
# `len(graded_exceptions) + len(errored_ran_ungraded)` -- an errored-ran
# ungraded trial is ALSO in `errored_rows`, because it was just added to
# `trials` above with `errored=True`. A non-run trial is NOT, by design: it
# is excluded rather than scored (see `trial_agent_produced_work`).
n_graded_exceptions = len(graded_exceptions)
n_errored_ran_ungraded = len(errored_ran_ungraded)
n_non_run = len(non_run_exceptions)
n_ungraded_exceptions = n_errored_ran_ungraded + n_non_run
n_all_exceptions = n_graded_exceptions + n_ungraded_exceptions
n_graded_exceptions_pass = sum(1 for _t, _exc, r, _tid in graded_exceptions if r >= 1.0)

print(f"  prefixes merged    : {len(prefixes)}  ({', '.join(prefixes)})")
print(f"  jobs merged        : {seen_jobs}")
print(f"  trials on disk     : {n_trials}")
print(f"  distinct tasks     : {n_tasks} / {expected} expected")
print(f"  errored trials     : {n_all_exceptions} (graded despite the exception: {n_graded_exceptions}, of which reward 1.0: {n_graded_exceptions_pass})")
print(f"  tasks with NO clean trial : {len(all_errored_tasks)}  (scored 0.0, kept in the denominator)")
if off_identity:
    n_off = sum(len(v) for v in off_identity.values())
    print(f"  OFF-IDENTITY excluded     : {n_off} trial(s) across {len(off_identity)} eval key(s) — wrong (agent,model) for this cohort, never pooled")
    for key, tasks in sorted(off_identity.items()):
        print(f"      {key}  ->  {', '.join(sorted(tasks))}")
if quarantined_rows:
    print(f"  INTEGRITY-QUARANTINED     : {len(quarantined_rows)}  (reached the benchmark's own oracle; forced to 0.0)")
    for task, tid, was in quarantined_rows:
        print(f"      {tid}  (verifier said {was:.1f}, counted 0.0)")
if accepted:
    # ⛔ THIS LINE USED TO CLAIM "counted as 0.0" AND NOTHING IMPLEMENTED IT.
    # `accepted` was read, intersected, printed, and never applied — the score
    # came from reward_stats either way. The label was false in both directions:
    # a task that exhausted its retries and never passed already scores 0 without
    # help, and one that exhausted its retries and LATER PASSED on another prefix
    # was being announced as a zero while correctly counting as solved.
    #
    # The fix is NOT to start zeroing them. `adaptive-rejection-sampler` sits in
    # this ledger and passes 5 of 5 trials; forcing it to 0 would understate a
    # real result to satisfy a stale ledger entry. The ledger records that the
    # SWEEP stopped retrying, which is a scheduling fact, not a verdict on the
    # task. So print what is true: the entry, and its actual score.
    listed = sorted(accepted & set(trials))
    print(f"  retry budget exhausted : {len(listed)}  (scheduling ledger; scored from trials, NOT forced to 0)")
    for t in listed:
        got = per_task_official.get(t)
        n_pass = sum(1 for r, e, _, _ in trials[t] if not e and r >= 1.0)
        print(f"      {t}: scored {got:.1f} ({n_pass}/{len(trials[t])} trial(s) passed)")
print("")
# ⛔ THE HEADLINE IS PER-TRIAL, AND THIS SCRIPT USED TO CALL THE PER-TASK RATE
# "OFFICIAL". Read from the leaderboard's own source rather than assumed
# (D:/Git/terminal-bench-2-1/leaderboard/src/leaderboard/core/metrics.py:37):
#
#     accuracy = 100.0 * successful / total        # successful TRIALS / total TRIALS
#
# and SUBMIT.md's CI summary reports "accuracy ± SE ... across all trials", with
# a disqualified trial counting reward 0. So the leaderboard's Accuracy column is
# the per-TRIAL mean; the per-TASK solve rate is a DIFFERENT quantity that this
# script was publishing under the name "OFFICIAL". The header note claiming "the
# leaderboard reports per-TASK" was wrong and is corrected there too.
#
# Both are printed because both are worth knowing and they answer different
# questions — "how reliable is it" vs "can it ever do this" — and conflating them
# is exactly how a 89/89 gets read as 100%. Measured 2026-08-12: 405 of 493
# trials passed (82.15%) while all 89 tasks were solved at least once, and only
# 63 of 89 tasks passed EVERY trial.
#
# accuracy_stderr uses the leaderboard's own per-task formula
# s^2 = (1/n^2) * sum_i p_i(1-p_i)/(k_i-1), skipping k<2 tasks (undefined there).
n_success = sum(1 for rows in trials.values() for r, e, _, _ in rows if not e and r >= 1.0)
n_trials_all = sum(len(rows) for rows in trials.values())
accuracy = 100.0 * n_success / n_trials_all if n_trials_all else 0.0
_var = 0.0
for rows in trials.values():
    k = len(rows)
    if k < 2:
        continue
    p = sum(1 for r, e, _, _ in rows if not e and r >= 1.0) / k
    _var += p * (1.0 - p) / (k - 1)
_var = _var / (n_tasks * n_tasks) if n_tasks else 0.0
acc_se = 100.0 * _var**0.5

print(f"  ACCURACY (per-trial): {accuracy:.2f}% +/- {acc_se:.2f}%   <- THE LEADERBOARD'S Accuracy column:")
print(f"      {n_success} of {n_trials_all} trials passed. metrics.py: successful/total TRIALS, errored+quarantined = 0.")
print(f"  tasks solved       : {int(sum(per_task_official.values()))}/{n_tasks} ({off:.4f})   <- >=1 passing trial; NOT the Accuracy column")
print(f"  diagnostic per-task: {diag:.4f}   <- errored-only tasks EXCLUDED; infra-vs-capability only")
print(f"  cost_usd THIS COHORT: ${cost:.2f}   <- {jobs_dir} + the listed prefixes ONLY")
if barren_jobs:
    print(f"      of which ${barren_cost:.2f} bought no trial ({barren_jobs} job(s) with a result.json but no evals)")
if cost_missing:
    # ⛔ THIS LINE USED TO SAY "real spend, not counted above" UNCONDITIONALLY —
    # false the moment a fallback recovers even one of these jobs. cost_missing
    # is now three DISTINCT things and each is printed as its own line so a
    # reader can tell a complete total from a partial one at a glance: how many
    # result.json files lacked cost_usd at all, how many of those got a dollar
    # figure back from raw token usage (and how much, already folded into the
    # total above), and how many stayed genuinely unrecoverable and excluded.
    print(f"      {cost_missing} job(s) reported NO cost_usd in result.json")
    if cost_recovered_jobs:
        print(f"          -> ${cost_recovered_usd:.2f} RECOVERED from {cost_recovered_jobs} job(s) via raw trial-transcript token usage (already included in the total above)")
    if cost_unrecoverable_jobs:
        print(f"          -> {cost_unrecoverable_jobs} job(s) excluded, cost unrecoverable -- real spend, NOT counted above, so the total is a LOWER BOUND")
        for rj, reason in unrecoverable_reasons[:10]:
            print(f"               {rj}  ({reason})")
        if len(unrecoverable_reasons) > 10:
            print(f"               … and {len(unrecoverable_reasons)-10} more")
print( "      NOT a session or account total: this counts harbor job spend for this")
print( "      cohort only. Other Claude Code sessions on this machine are billed")
print( "      separately and never appear here.")

# ── the verdict, gated ───────────────────────────────────────────────────
#
# ⛔ THIS GATE USED TO ASSERT AN ENVIRONMENT VARIABLE, NOT THE DATA.
#
# It read `required_k = int(os.environ.get("TRIALS_REQUIRED", "1"))`, fed from
# `TRIALS_REQUIRED="${TB_ATTEMPTS:-1}"` at the top of this script, and then
# compared that number against 5. Nothing anywhere counted trials per task.
# The consequences ran in BOTH directions and both are fatal:
#
#   * In any shell where TB_ATTEMPTS is unset — which includes the `Reproduce`
#     command this repo publishes, `bash merge-sweep.sh jobs-sonnet5` — it
#     defaulted to 1 and printed "NO VERDICT — k=1 (<5)". Measured 2026-08-12:
#     that fired on a cohort whose REAL minimum was 5 trials on all 89 tasks.
#     A complete, submittable run was reported as short, which is how a sweep
#     gets re-run for nothing.
#   * Exported TB_ATTEMPTS=5 and it printed the verdict without inspecting a
#     single trial — so a k=1 probe would have rendered "BEATS THE BAR".
#
# `rules/tests-must-be-able-to-fail.md`: a gate whose assertion is about its own
# inputs rather than the measured artifact cannot fail on real data. The bar the
# leaderboard actually sets is ">= 5 trials per task" (leaderboard/SUBMIT.md), so
# the quantity to check is the OBSERVED MINIMUM over tasks, computed from the
# trials already collected above. TB_ATTEMPTS remains readable as the run's
# INTENT, and a mismatch between intent and reality is itself worth printing.
observed_k = min((len(rows) for rows in trials.values()), default=0)
tasks_below_k = sorted(t for t, rows in trials.items() if len(rows) < 5)

incomplete = []
if n_tasks < expected:
    incomplete.append(f"{n_tasks}/{expected} tasks")
if observed_k < 5:
    incomplete.append(f"min observed k={observed_k} (<5) on {len(tasks_below_k)} task(s)")
print("")
print(f"  trials per task    : min {observed_k}, max {max((len(r) for r in trials.values()), default=0)}"
      f"  (leaderboard requires >= 5 on EVERY task)")
if required_k and required_k != observed_k:
    print(f"      note: TB_ATTEMPTS={required_k} was the run's INTENT; the number above is what is on disk")
if tasks_below_k:
    print(f"      BELOW 5: {', '.join(tasks_below_k[:12])}"
          + (f" … and {len(tasks_below_k)-12} more" if len(tasks_below_k) > 12 else ""))
# ⛔ THE BAR COMPARISON WAS WRONG IN QUANTITY *AND* IN SCALE, AND THEREFORE
# ALWAYS SAID "BEATS THE BAR".
#
# It evaluated `off > 0.838`, where `off` is the per-TASK solve rate on a 0..1
# scale. The bar is the owner gate from rules/tbench-playbook.md ("Submit only
# if it beats 83.8 %"), an ACCURACY figure — and the leaderboard pins accuracy
# to a 0..100 percentage (leaderboard/leaderboard.yaml: `accuracy: minimum 0,
# maximum 100`). So a 0..1 per-task rate was being compared against a percentage
# expressed as a fraction, mixing two different quantities on two different
# scales.
#
# The failure mode was not random, it was one-directional: any run that solves
# every task at least once has off == 1.0, which exceeds 0.838 unconditionally.
# So the gate rendered "BEATS THE BAR" for every complete run no matter how
# unreliable it was. Measured 2026-08-12: this cohort solved 89/89 (off=1.0000)
# and printed "BEATS THE BAR" while its real Accuracy was 82.15% — BELOW the
# 83.8% bar it claimed to clear.
BAR_ACCURACY_PCT = 83.8
if incomplete:
    print(f"  bar {BAR_ACCURACY_PCT:.1f}% Accuracy : NO VERDICT — {', '.join(incomplete)}; not comparable to the bar")
else:
    verdict = "BEATS THE BAR" if accuracy > BAR_ACCURACY_PCT else "BELOW THE BAR"
    print(f"  bar {BAR_ACCURACY_PCT:.1f}% Accuracy : {verdict}"
          f"  ({accuracy:.2f}% vs {BAR_ACCURACY_PCT:.1f}%)")
    print(f"      compared on the LEADERBOARD'S metric (per-trial Accuracy), not the")
    print(f"      per-task solve rate — solving every task once is not the same claim.")

if unreadable:
    print("")
    print(f"  *** {len(unreadable)} UNREADABLE result.json — these left the denominator: ***")
    for rj, why in unreadable[:10]:
        print(f"    {rj}  ({why})")

if errored_rows:
    print("")
    print("  errored trials (re-run or exclude, and SAY WHICH):")
    for t, exc in errored_rows[:25]:
        print(f"    {exc:<28} {t}")
    if len(errored_rows) > 25:
        print(f"    … and {len(errored_rows)-25} more")

# TBENCH-LATE-API-RETRY-1: these are the same rows as `errored_rows` above,
# with the verifier's actual grade attached -- the fact the retry hook now
# leaves standing instead of deleting and re-running.
if graded_exceptions:
    print("")
    print("  graded despite the exception (task, exception, reward):")
    for task, exc, reward, tid in sorted(graded_exceptions, key=lambda row: (row[0], row[3]))[:25]:
        print(f"    {exc:<28} {task:<40} reward={reward:.1f}  {tid}")
    if len(graded_exceptions) > 25:
        print(f"    … and {len(graded_exceptions)-25} more")

# TBENCH-HOST-SPAWN-WAIT-1: exception_stats entries reward_stats never gets to
# see -- the verifier never ran, so there is no reward to print. Before this
# reader these trials were invisible to merge-sweep.sh entirely, not merely
# uncounted (see .tb-hook-notes.jsonl "before any agent work" for the retry
# that consumed each one; retry-disclosure.mjs counts those against the
# job's time span). K1 of them (the agent ran) are now ALSO in `errored_rows`
# above, scored 0 and counted in the denominator; K2 (no evidence the agent
# ever ran) are excluded instead -- see `trial_agent_produced_work` and the
# comment above `trials`.
if n_ungraded_exceptions:
    print("")
    print(
        f"  errored, no grade (exception_stats only, never reached reward_stats): {n_ungraded_exceptions} "
        f"(K1={n_errored_ran_ungraded} counted as 0, K2={n_non_run} excluded as non-runs)"
    )

# ⛔ THIS EXCLUSION MUST BE DISCLOSED. root-cause-findings-2026-09-07.md §26
# (commit f9dccd98) applied `reference_run_that_never_happened_is_not_a_failure`
# to exactly one trial, BY HAND, and disclosed it in the write-up. This section
# is that same call made in code, for every ungraded exception, not just the
# one someone happened to notice -- which is precisely why it cannot be silent.
if non_run_exceptions:
    print("")
    print("  excluded non-runs (zero tokens, no agent step -- reference: root-cause-findings-2026-09-07.md §26 / f9dccd98):")
    sorted_non_runs = sorted(non_run_exceptions, key=lambda row: (row[0], row[2]))
    for task, exc, tid, evidence in sorted_non_runs[:25]:
        print(f"    {exc:<28} {task:<40} {tid}  ({evidence})")
    if len(sorted_non_runs) > 25:
        print(f"    … and {len(sorted_non_runs)-25} more")
    print("      DISCLOSURE REQUIRED: any submission excluding these must state how many and why, per §26's own precedent.")

print("")
print("  SUBMISSION REQUIREMENTS (leaderboard/SUBMIT.md):")
print("    * every task covered, >=5 trials each -- a k=1 run is NOT submittable")
print("    * errored trials count as reward 0, never excluded")
print("    * default execution settings; no timeout or resource overrides")
print("  Do not attach TerranSoul's name unless check-terransoul-used.sh confirmed")
print("  real brain calls, and disclose that memory WRITES occurred during the run.")

sys.exit(1 if unreadable else 0)
PY
