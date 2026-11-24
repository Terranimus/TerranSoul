# Native writing: no AI tells, no translated text (the owner, 24 Nov 2026)

The owner, 24 Nov 2026, verbatim: "learn this https://github.com/conorbronsdon/avoid-ai-writing and apply for all repos and
AI.Template and Memo so all our of apps are native languagues." Memo lesson 787497.

## Symptom

App copy, UI text, docs and agent replies read as written by a model or translated from English: stock words (seamless,
robust, leverage, delve), hedging, em-dash chains, rule-of-three padding, chatbot lines ("I hope this helps"), and in other
languages passive calques, "một cách", 을(를), 进行, канцелярит.

## The rule

1. Every agent applies the `avoid-ai-writing` skill (vendored from upstream, MIT, see its `UPSTREAM.md`) to anything a
   person reads: UI strings in all languages, emails, error messages, landing pages, README intros, docs, PR bodies and
   its own replies. For a language other than English it also reads
   `.claude/skills/avoid-ai-writing/references/terranimus-languages.md`, the language's section of
   `multilingual-native-copy/references/language-notes.md`, and for Vietnamese the `vietnamese-writing` skill.
2. Write natively from what the text must do for the reader. Never translate sentence by sentence.
3. A style pass never changes meaning, i18n keys, placeholders, numbers, product names or legal text.
4. Every app runs the guard `node scripts/check-ai-tells.mjs` in its tests (or `npm run check:ai-tells`). It fails on
   the clear-cut tells in every i18n catalog. A justified exception goes in `.ai-tells-allow.json` with a reason.
5. It works with `rules/no-ai-characters.md` (no em dashes, curly quotes, ellipsis characters or arrows in
   human-readable text) and its lint `scripts/lint-ai-characters.mjs`.
6. The guard is a floor. Review new copy with the skill's detect mode as well: most tells need a reader.

## Where it lives

- Skill: `.claude/skills/avoid-ai-writing/` (upstream copy plus the seven-language reference).
- Guard: `scripts/check-ai-tells.mjs` and its test.
- AI.Template copies the skill, this rule and the guard to every app repo with `scripts/sync-to-repos.mjs`.
- Memo carries the same skill and rule, and its own agent replies and seeded procedures follow it.
