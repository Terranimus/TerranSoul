# Upstream

- Source: https://github.com/conorbronsdon/avoid-ai-writing (folder `plugins/avoid-ai-writing/skills/avoid-ai-writing`,
  identical to the repo's canonical `SKILL.md`, `references/`, `detector/`, `scripts/` and `examples/`)
- Commit: `cd5573a185f3ab468b094fc2cf2fa193fcaeaf53` (2026-11-23, "fix(scripts): split reference modules on headings indented up to three spaces"),
  skill version 3.39.0, vendored 2026-11-24 at the owner's request (Memo 787497).
- Licence: MIT, Copyright (c) 2026 Conor Bronsdon. `LICENSE` and `NOTICE.md` are copied unchanged.
- Upstream files are unchanged. Left out: upstream's tests, evals, corpus, Vale export, CI, plugin manifests and the
  optional router and workflow skills.

## Local additions (not upstream)

- `references/terranimus-languages.md`: AI tells and translation tells for our seven languages (en vi ja ko zh hi ru).
  Upstream's rules are calibrated for English only.
- `package.json` with `"type": "commonjs"`, so the upstream `.js` scripts (`require`) run inside repos whose root
  `package.json` sets `"type": "module"`.
- `UPSTREAM.md` and `CREDITS.md` (this attribution).

The rule that tells agents to use it is `rules/native-writing.md`; the i18n guard is `scripts/check-ai-tells.mjs`.

## Refresh

Re-copy the folder from upstream at a new commit, read the diff, update the commit above, keep the local additions, and
run `node scripts/check-skills.mjs`. Never edit the upstream files in place.
