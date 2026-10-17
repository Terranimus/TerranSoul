# Terminal-Bench 2.1 — TerranSoul + Claude Code

| Agent | Model | Effort | Accuracy | Date | Agent Org | Model Org | Hacks | Cost |
|---|---|---|---|---|---|---|---|---|
| TerranSoul | Claude Sonnet 5 | none | **83.0% ± 1.7%** | Aug 12, 2026 | Terranimus | Anthropic | −1.0% | $423.53 |

| metric | value |
|---|---|
| tasks solved (any trial) | **88 / 89** |
| pass@1 | 0.8872 |
| pass@2 | 0.9467 |
| pass@3 | 0.9610 |
| pass@5 | 0.9706 |
| trials | 487 (2 errored, scored 0; 5 integrity-quarantined, forced to 0) |
| unsolved | `filter-js-from-html` |

Configuration: agent `terransoul:TerranSoul`, model `claude-sonnet-5`, dataset
`terminal-bench/terminal-bench-2-1@sha256:7d7bdc1c…`, default execution settings,
no timeout or resource overrides.

## Reproduce

```sh
cd benchmark/terminal-bench
bash merge-sweep.sh jobs-sonnet5       # official number; identity filter + integrity quarantine applied
python integrity-scan.py jobs-sonnet5  # exit 1 = contamination
```

Requires a running TerranSoul brain. The bench uses an **isolated** brain on
`:7424` (`mcp-data-tbench/`) so a benchmark that writes to memory can never
mutate the production store on `:7423`.

## Disclosures owed on any submission

1. **Memory writes occurred during the run.** The agent wrote lessons a later
   attempt could read, so trials are **not i.i.d.** and this is not pass@5 on
   independent samples.
2. **5 trials are integrity-quarantined** for reaching the benchmark's own
   oracle or grading material. They count as reward 0 and must be listed in
   `disqualified_trials`, not withheld.
3. **Accuracy is the mean per-trial reward** over all 487 trials with errored
   and quarantined trials scored 0 — the same quantity the leaderboard's
   Accuracy column reports.
