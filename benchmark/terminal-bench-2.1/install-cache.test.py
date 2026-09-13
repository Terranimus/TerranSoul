# -*- coding: utf-8 -*-
"""Tests for the per-sweep agent install cache in `terransoul_hook.py`.

FAILS ON THE PRE-CHANGE TREE: `_restore_cached_agent` / `_populate_agent_cache`
/ `_agent_cache_root` did not exist, so every case below raises AttributeError.

⛔ WHAT THESE PIN, AND WHY EACH ONE MATTERS. The cache exists to remove a
measured 1.6% per-trial loss to `AgentSetupTimeoutError` (5 of 305 trials since
2026-09-01), which over 89 tasks is a ~76% chance of losing at least one trial
to setup alone. But a cache that can BREAK a trial is far worse than the tax it
removes, so the invariant under test is: it may only ever make setup faster,
never make it fail. Every failure path must fall through to the stock install.

LOCAL-ONLY by construction: importing the hook needs `harbor`, which lives in
the uv tool venv. Absent that, this SKIPs cleanly rather than failing (see
rules/ci-vs-local-testing.md).
"""

import asyncio
import os
import sys
import tempfile
from pathlib import Path

_HARBOR_SITE = Path(
    os.environ.get("TB_HARBOR_SITE")
    or Path.home() / "AppData/Roaming/uv/tools/harbor/Lib/site-packages"
)
if _HARBOR_SITE.exists():
    sys.path.insert(0, str(_HARBOR_SITE))
sys.path.insert(0, str(Path(__file__).resolve().parent))

# ⛔ A SKIP THAT CANNOT BE DISTINGUISHED FROM A PASS IS A TEST THAT CANNOT FAIL.
# harbor needs `typing.override`, i.e. Python >= 3.12, and the `python` on PATH
# here is 3.11 -- so an npm script that simply ran `python` would SKIP on the one
# machine that actually has harbor installed, forever, while reporting success.
# Re-exec once under an interpreter new enough to import it before giving up.
if sys.version_info < (3, 12) and not os.environ.get("TB_TEST_REEXEC"):
    import shutil
    import subprocess

    _py = shutil.which("py")
    for _args in ((["-3.13"], ), (["-3.12"], )) if _py else ():
        _probe = subprocess.run(
            [_py, *_args[0], "-c", "import sys; print(sys.version_info[:2])"],
            capture_output=True,
        )
        if _probe.returncode == 0:
            os.environ["TB_TEST_REEXEC"] = "1"
            raise SystemExit(
                subprocess.run([_py, *_args[0], str(Path(__file__).resolve())]).returncode
            )

try:
    from terransoul_hook import TerranSoulHook
except Exception as exc:  # noqa: BLE001
    # The reason is part of the message on purpose: "harbor is not installed" is
    # a legitimate skip (see rules/ci-vs-local-testing.md); "this interpreter is
    # too old" is a local misconfiguration that must not read as the same thing.
    _why = (
        f"interpreter is {sys.version_info[0]}.{sys.version_info[1]}, harbor needs >= 3.12"
        if sys.version_info < (3, 12)
        else f"{type(exc).__name__}: {exc}"
    )
    print(f"SKIP install-cache.test.py: harbor not importable ({_why})")
    raise SystemExit(0)

fails = 0


def check(label, expected, actual):
    global fails
    if expected == actual:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label}: expected [{expected}] got [{actual}]")
        fails += 1


class Res:
    def __init__(self, code=0, out=""):
        self.return_code = code
        self.stdout = out


class FakeSelf:
    """Stands in for the hook: only the primitives that touch the OS are faked."""

    def __init__(self, cache, *, apk=False, claude_ok=True, deps=True,
                 preinstalls=True, repair_says="REPAIR_OK"):
        self._cache = cache
        self._apk = apk
        self._claude_ok = claude_ok
        # Images that already carry curl/bash/node/npm/pgrep are the ONLY
        # ones the cache helps; default True so existing cases keep testing
        # the restore path itself.
        self._deps = deps
        # Whether the ordinary apt install manages to produce the five packages.
        self._preinstalls = preinstalls
        self._repair_says = repair_says
        self.uploaded = []
        self.downloaded = []
        self.removed = []

    # The REAL implementation, not a fake: it is part of the code under test
    # and it only reaches the OS through exec_as_agent, which is faked.
    _container_home = TerranSoulHook._container_home

    def _agent_cache_root(self):
        return self._cache

    async def exec_as_root(self, environment, command):
        # ⛔ Harbor RAISES on any non-zero exit, so every probe exits 0 and
        # answers on stdout. The fake mirrors that contract exactly; a fake
        # that returned exit 1 would let a probe pass here and throw in
        # production, which is what happened on 2026-09-05.
        if "apk" in command:
            return Res(0, "ALPINE" if self._apk else "OTHER")
        if "DEPS_OK" in command:
            return Res(0, "DEPS_OK" if self._deps else "DEPS_MISSING")
        if "PREINSTALL_OK" in command:
            return Res(0, "PREINSTALL_OK" if self._preinstalls else "PREINSTALL_INCOMPLETE")
        if "REPAIR_OK" in command:
            return Res(0, self._repair_says)
        return Res(0)

    async def exec_as_agent(self, environment, command):
        if "$HOME" in command or "printf" in command:
            return Res(0, "/home/agent")
        if "claude --version" in command:
            # Never a non-zero exit: the command is `... || echo CACHE_UNUSABLE`.
            return Res(0, "2.1.0") if self._claude_ok else Res(0, "CACHE_UNUSABLE")
        if command.startswith("rm -rf"):
            self.removed.append(command)
        return Res(0)


class FakeEnv:
    def __init__(self, owner, *, produce_claude=True):
        self._o = owner
        self._produce = produce_claude

    async def upload_dir(self, src, dst):
        self._o.uploaded.append((str(src), dst))

    async def download_dir(self, src, dst):
        self._o.downloaded.append((src, str(dst)))
        d = Path(dst)
        (d / "bin").mkdir(parents=True, exist_ok=True)
        if self._produce:
            (d / "bin" / "claude").write_text("#!/bin/sh\n")


# ⛔ WINDOWS' DEFAULT LOOP FAILS AT INTERPRETER SHUTDOWN, NOT DURING THE TEST.
# Every case here calls asyncio.run(), and ProactorEventLoop.__del__ can fire
# after its own internals are torn down:
#   AttributeError: 'ProactorEventLoop' object has no attribute '_ssock'
# which exits 1 AFTER printing ALL PASS -- a green run reported as a red one,
# and it surfaced only once this file was launched through a pipe. The selector
# loop has no self-pipe to tear down; nothing here needs the proactor.
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

run = asyncio.run
# The behavioural cases exercise the INNER methods; the wrappers are tested
# separately, at the bottom, for total fault containment.
restore = TerranSoulHook._restore_cached_agent_inner
populate = TerranSoulHook._populate_agent_cache_inner

with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)

    print("== a missing cache is a no-op, not a failure ==")
    empty = tmp / "none"
    s = FakeSelf(empty)
    check("no cache -> False", False, run(restore(s, FakeEnv(s))))
    check("nothing uploaded", 0, len(s.uploaded))

    # Build a populated cache for the remaining cases.
    cache = tmp / "sweep-x"
    (cache / "bin").mkdir(parents=True)
    (cache / "bin" / "claude").write_text("#!/bin/sh\n")

    print("== a usable cache is restored, and the download is skipped ==")
    s = FakeSelf(cache)
    check("restore -> True", True, run(restore(s, FakeEnv(s))))
    check("uploaded exactly once", 1, len(s.uploaded))
    check("uploaded to the agent's ~/.local", "/home/agent/.local", s.uploaded[0][1])

    print("== ALPINE takes the npm branch upstream, so a glibc tree must not be sent ==")
    s = FakeSelf(cache, apk=True)
    check("alpine -> False", False, run(restore(s, FakeEnv(s))))
    check("nothing uploaded on alpine", 0, len(s.uploaded))

    # ⛔ THE INVARIANT. A tree from a different libc/arch uploads perfectly and
    # then cannot run. That must degrade to a normal stock install, never to a
    # dead trial -- the cache may only make setup faster, never make it fail.
    print("== an UNRUNNABLE cached binary falls back and cleans up ==")
    s = FakeSelf(cache, claude_ok=False)
    check("unrunnable -> False", False, run(restore(s, FakeEnv(s))))
    check("the half-restored binary is removed", 1, len(s.removed))

    print("== capture publishes by RENAME, and only a real tree ==")
    fresh = tmp / "sweep-new"
    s = FakeSelf(fresh)
    run(populate(s, FakeEnv(s)))
    check("cache now exists", True, (fresh / "bin" / "claude").exists())
    check("no .partial left behind", False, fresh.with_name(fresh.name + ".partial").exists())

    print("== a capture that yields no agent is discarded, not published ==")
    bad = tmp / "sweep-bad"
    s = FakeSelf(bad)
    run(populate(s, FakeEnv(s, produce_claude=False)))
    check("a tree without the binary is NOT published", False, bad.exists())

    print("== an existing cache is not re-captured ==")
    s = FakeSelf(cache)
    run(populate(s, FakeEnv(s)))
    check("no download when the cache is already present", 0, len(s.downloaded))

    print("== TB_AGENT_CACHE=0 disables the whole mechanism ==")
    os.environ["TB_AGENT_CACHE"] = "0"
    try:
        check("disabled -> no cache root", None, TerranSoulHook._agent_cache_root(FakeSelf(cache)))
    finally:
        del os.environ["TB_AGENT_CACHE"]

print("== a DANGLING bin/claude symlink still counts as a usable cache ==")
# ⛔ MEASURED 2026-09-05, and it discarded a perfectly good tree twice.
# `~/.local/bin/claude` is a SYMLINK into share/claude/versions/<v>. Path.exists()
# FOLLOWS symlinks, so once the tree is copied to a Windows host where the target
# does not resolve, exists() answers False for a complete cache. The note that
# finally exposed it recorded local_bin ["claude"] alongside the discard.
# Every other case here writes bin/claude as a REAL FILE, so none of them could
# have caught this -- the fixture was wrong, not the assertion.
sym = tmp2 = Path(tempfile.mkdtemp())
try:
    (sym / "bin").mkdir(parents=True)
    made = False
    try:
        (sym / "bin" / "claude").symlink_to(sym / "share" / "claude" / "versions" / "9.9.9")
        made = True
    except (OSError, NotImplementedError):
        print("  skip  (this OS/user cannot create symlinks)")
    if made:
        check("the dangling link is invisible to exists()", False, (sym / "bin" / "claude").exists())
        check("but lexists sees it", True, os.path.lexists(sym / "bin" / "claude"))
        s2 = FakeSelf(sym)
        check("a symlinked cache is usable", True, run(restore(s2, FakeEnv(s2))))
finally:
    import shutil as _sh
    _sh.rmtree(tmp2, ignore_errors=True)

print("== an image that still needs apt-get is NOT worth restoring into ==")
# ⛔ MEASURED 2026-09-05 MID-SWEEP, and it cost four tasks. The restore
# succeeded and the job log then read:
#     Claude Code is already available at the requested version
#     Running command: apt-get update && apt-get install -y curl bash nodejs npm procps
#     Agent setup timed out after 360.0 seconds
# The cache TRADES a ~297 MB download for a ~205 MB upload. That is a win only
# when the image already has the dependencies; when apt-get must run anyway the
# upload is pure added cost, and the pair crosses the 360 s budget on images
# that passed comfortably before the cache existed.
# ⛔ ITS OWN LIVE CACHE. The first draft reused `cache` from the `with` block
# above, which had already been torn down -- so the FIRST guard (lexists on a
# missing tree) returned False and the assertion passed no matter what the deps
# gate did. Mutating the gate away left it green. That is the fourth
# fixture-shaped tautology in this session: the assertion was right and the
# world it ran in was wrong.
_dtmp = Path(tempfile.mkdtemp())
try:
    (_dtmp / "bin").mkdir(parents=True)
    (_dtmp / "bin" / "claude").write_text("placeholder")
    # Sanity: the cache must be USABLE, or this proves nothing about the gate.
    ok = FakeSelf(_dtmp, deps=True)
    check("control: with deps present the cache IS restored", True, run(restore(ok, FakeEnv(ok))))
    s = FakeSelf(_dtmp, deps=False)
    check("deps missing -> restore refused", False, run(restore(s, FakeEnv(s))))
    check("deps missing -> nothing uploaded", 0, len(s.uploaded))
finally:
    import shutil as _sh2
    _sh2.rmtree(_dtmp, ignore_errors=True)

print("== the fast dependency preinstall never raises, and skips when unneeded ==")
# ⛔ MEASURED 2026-09-05: the setup budget is blown by apt failing SLOWLY under
# contention (exit 100, Ign: on both ubuntu hosts), not by apt being down -- a
# bare `docker run ubuntu apt-get update` on this host succeeded 3/3. This runs
# the SAME five packages harbor would install, with short timeouts so a failure
# costs seconds instead of a minute. It is an OPTIMISATION, so it must be
# incapable of failing a trial: harbor turns any non-zero exit into
# NonZeroAgentExitCodeError, which aborts the trial outright.
class DepsSelf(FakeSelf):
    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.root_cmds = []

    async def exec_as_root(self, environment, command):
        self.root_cmds.append(command)
        return await FakeSelf.exec_as_root(self, environment, command)

pre = TerranSoulHook._preinstall_deps_fast

d1 = DepsSelf(cache, deps=True)
run(pre(d1, FakeEnv(d1)))
check("deps already present -> no apt-get issued", 0,
      len([c for c in d1.root_cmds if "apt-get" in c]))

d2 = DepsSelf(cache, deps=False, apk=True)
run(pre(d2, FakeEnv(d2)))
check("alpine -> no apt-get issued", 0,
      len([c for c in d2.root_cmds if "apt-get" in c]))

d3 = DepsSelf(cache, deps=False)
run(pre(d3, FakeEnv(d3)))
apt=[c for c in d3.root_cmds if "apt-get" in c]
check("deps missing -> apt-get is issued", 1, len(apt))
check("with a bounded http timeout", True, "Acquire::http::Timeout=12" in (apt[0] if apt else ""))
check("and apt-level retries", True, "Acquire::Retries=3" in (apt[0] if apt else ""))

# ⛔ THE INVARIANT: an optimisation may never fail a trial.
class Boom(DepsSelf):
    async def exec_as_root(self, environment, command):
        raise RuntimeError("network gone")

b = Boom(cache, deps=False)
try:
    run(pre(b, FakeEnv(b)))
    check("a throwing preinstall is swallowed", True, True)
except Exception as exc:  # noqa: BLE001
    check("a throwing preinstall is swallowed", True, f"RAISED {type(exc).__name__}")

print("== an end-of-life apt suite is repaired, and only after the normal path loses ==")
# FAILS ON THE PRE-CHANGE TREE: `_APT_EOL_SNAPSHOT_REPAIR` did not exist, so the
# import below raises AttributeError, and `_preinstall_deps_fast` issued exactly
# one apt-get command whether or not it produced the dependencies.
#
# WHY THIS MATTERS: qemu-alpine-ssh and qemu-startup were UNMEASURED in the
# 2026-09-07/08 sweep -- 8 and 9 setup failures across days, agent never started.
# Debian 11 LTS ended 2026-08-31; the image's baked apt index still validates
# against the mirror, so apt USES it, and it names pool files that are now 404.
import terransoul_hook as _th
# getattr, not `from ... import`: on the pre-change tree the constant is
# absent, and an ImportError here would abort before the checks below could
# report WHICH properties are missing.
REPAIR = getattr(_th, "_APT_EOL_SNAPSHOT_REPAIR", "")
check("the repair script exists at all", True, bool(REPAIR))

d4 = DepsSelf(cache, deps=False, preinstalls=True)
run(pre(d4, FakeEnv(d4)))
check("preinstall succeeded -> no EOL repair attempted", 0,
      len([c for c in d4.root_cmds if "REPAIR_OK" in c]))

d5 = DepsSelf(cache, deps=False, preinstalls=False)
run(pre(d5, FakeEnv(d5)))
check("preinstall incomplete -> the EOL repair runs", 1,
      len([c for c in d5.root_cmds if "REPAIR_OK" in c]))
check("and it runs AFTER the ordinary attempt, never instead of it", True,
      len([c for c in d5.root_cmds if "PREINSTALL_OK" in c]) == 1)

d6 = DepsSelf(cache, deps=True, preinstalls=False)
run(pre(d6, FakeEnv(d6)))
check("deps already present -> neither install nor repair", 0,
      len([c for c in d6.root_cmds if "apt-get" in c]))

# ⛔ AGI PURITY. The repair may not carry task, distro or release knowledge: the
# snapshot pin is read out of whatever the image itself shipped. If a suite name
# or a pinned timestamp ever appears here, this has become injected knowledge.
for banned in ("bullseye", "bookworm", "trixie", "qemu", "deb11", "20251020", "20260824"):
    check("repair names no distro/task/pin: %s" % banned, False, banned in REPAIR)

# ⛔ IT MAY NEVER MAKE A TRIAL WORSE. It is reached only after the ordinary path
# has already failed, it backs the file up, and it puts the backup back when the
# swapped index does not fetch.
check("backs up sources.list before touching it", True, "ts-bak" in REPAIR)
check("restores the backup when the swap does not fetch", True, "REPAIR_REVERTED" in REPAIR)
check("bails out when the image ships no snapshot pin", True, "REPAIR_UNAVAILABLE" in REPAIR)

# ⛔ HARBOR RAISES ON ANY NON-ZERO EXIT, so every path must exit 0 and answer on
# stdout -- the same contract every probe in this file already obeys.
check("no path exits non-zero", False, "exit 1" in REPAIR)
check("every branch answers on stdout", True, REPAIR.count("echo REPAIR_") >= 4)

# ⛔ 80 OF 89 GRADERS RUN `apt-get update` AFTER THE AGENT STOPS. Snapshot Release
# files are expired by design, so without this drop-in the repaired box would
# hand the grader the exit 100 we just removed.
check("leaves a later bare apt-get update working", True,
      "Check-Valid-Until" in REPAIR and "apt.conf.d" in REPAIR)

print("== the REAL _agent_cache_root resolves, and never raises ==")
# ⛔ THIS IS THE CASE THAT WAS MISSING, AND IT COST 14 TRIALS. Every case above
# supplies its own `_agent_cache_root` through FakeSelf, so the REAL one -- the
# one that was broken -- was never executed. A test that stubs the method under
# test cannot fail for the defect in it. The bug: `_AGENT_CACHE_ENV` was
# indented into class scope, which a method body cannot resolve by bare name,
# so every call raised NameError and errored the install.
os.environ["TB_AGENT_CACHE_ID"] = "unit-test-sweep"
try:
    real = TerranSoulHook._agent_cache_root(object())
    check("real root is a Path", True, isinstance(real, Path))
    check("keyed by the sweep id", "sweep-unit-test-sweep", real.name if real else None)
    check("lives under the agent cache dir", ".tb-agent-cache", real.parent.name if real else None)
finally:
    del os.environ["TB_AGENT_CACHE_ID"]

print("== NOTHING from the cache path may reach install() ==")
# The inner methods each had a try/except, yet the calls made BEFORE those
# blocks were outside them. Containment must hold by construction, not by
# inspection -- so the wrappers are tested against an internal that throws.
class Exploding:
    async def _restore_cached_agent_inner(self, environment):
        raise RuntimeError("boom")

    async def _populate_agent_cache_inner(self, environment):
        raise RuntimeError("boom")

e = Exploding()
try:
    got = run(TerranSoulHook._restore_cached_agent(e, None))
    check("a raising restore degrades to False", False, got)
except Exception as exc:  # noqa: BLE001
    check("a raising restore degrades to False", False, f"RAISED {type(exc).__name__}")
try:
    run(TerranSoulHook._populate_agent_cache(e, None))
    check("a raising capture is swallowed", True, True)
except Exception as exc:  # noqa: BLE001
    check("a raising capture is swallowed", True, f"RAISED {type(exc).__name__}")

print("== adapter notes SURVIVE the run ==")
# ⛔ MEASURED 2026-09-05. `_install_stock_with_retry` promises in its docstring
# that every re-attempt "prints to stderr and lands in the trial's own log".
# Grepping a completed trial directory AND the run log for "terransoul-hook"
# found only harbor's rendering of the agent NAME -- zero adapter output. So
# every install retry the campaign performed was invisible, and the agent cache
# then failed with no trace of why. Notes must land somewhere that outlives the
# container.
import json as _json
import terransoul_hook as _th

with tempfile.TemporaryDirectory() as ntmp:
    notes = Path(ntmp) / "nested" / "notes.jsonl"
    orig = _th._HOOK_NOTES
    _th._HOOK_NOTES = notes
    try:
        _th._hook_note("something happened", detail="x")
        check("the note file is created", True, notes.exists())
        row = _json.loads(notes.read_text(encoding="utf-8").strip())
        check("message persisted", "something happened", row.get("message"))
        check("extra fields persisted", "x", row.get("detail"))
        check("timestamped", True, bool(row.get("at")))
    finally:
        _th._HOOK_NOTES = orig

# A note channel that can raise would be worse than no notes: it runs on the
# install path, which is inside the setup budget and outside any retry.
orig = _th._HOOK_NOTES
_th._HOOK_NOTES = Path(__file__).resolve() / "not-a-directory" / "notes.jsonl"
try:
    _th._hook_note("unwritable target must not raise")
    check("an unwritable note target is swallowed", True, True)
except Exception as exc:  # noqa: BLE001
    check("an unwritable note target is swallowed", True, f"RAISED {type(exc).__name__}")
finally:
    _th._HOOK_NOTES = orig

# ── TB-CACHE-COLD-KEY-1: the date key goes cold at midnight ─────────────────
#
# MEASURED 2026-09-07 02:42: nine consecutive single-task trials errored in
# `_install_stock_with_retry` with "curl: (60) SSL certificate problem" against
# downloads.claude.ai, while a COMPLETE 206 MB cache from 2026-09-06 23:25 sat
# one directory away, unconsulted -- the unset-id key is today's date and the
# day had just rolled over. The first trial of each day therefore carries a hard
# network dependency, and when that network is unhealthy the cache can never be
# populated either, so the whole day fails the same way.
#
# FAILS ON THE PRE-CHANGE TREE: `_cache_is_populated` did not exist
# (AttributeError) and `_agent_cache_root` returned today's path unconditionally.
import time as _time

class _FakeSelf:
    pass

def _cache_root_with(env, root):
    """Call the REAL method with a patched cache root."""
    orig_file = _th.__file__
    saved = dict(os.environ)
    try:
        os.environ.clear(); os.environ.update(env)
        # parents[2]/mcp-data/.tb-agent-cache must resolve to `root`
        fake = Path(root) / "benchmark" / "tb" / "hook.py"
        fake.parent.mkdir(parents=True, exist_ok=True)
        _th.__file__ = str(fake)
        return _th.TerranSoulHook._agent_cache_root(_FakeSelf())
    finally:
        _th.__file__ = orig_file
        os.environ.clear(); os.environ.update(saved)

with tempfile.TemporaryDirectory() as td:
    cache = Path(td) / "mcp-data" / ".tb-agent-cache"
    cache.mkdir(parents=True)
    old = cache / "sweep-20260906"
    (old / "bin").mkdir(parents=True)
    (old / "bin" / "claude").write_text("x", encoding="utf-8")
    _time.sleep(0.01)

    check("a populated tree is recognised", True, _th._cache_is_populated(old))
    check("an empty dir is not populated", False, _th._cache_is_populated(cache / "sweep-nope"))
    check("a missing path is not populated", False, _th._cache_is_populated(cache / "absent"))

    got = _cache_root_with({}, td)
    check("a cold date key falls back to the newest populated tree",
          old.name, got.name if got else None)

    got = _cache_root_with({"TB_AGENT_CACHE_ID": "sweepXYZ"}, td)
    check("an EXPLICIT sweep id is honoured exactly, never substituted",
          "sweep-sweepXYZ", got.name if got else None)

    got = _cache_root_with({"TB_AGENT_CACHE": "0"}, td)
    check("the cache can still be switched off entirely", None, got)

# With nothing populated at all it must return today's path, not None: that is
# the capture target for the first successful install.
with tempfile.TemporaryDirectory() as td2:
    (Path(td2) / "mcp-data" / ".tb-agent-cache").mkdir(parents=True)
    got = _cache_root_with({}, td2)
    check("an empty cache dir still yields today's capture target",
          True, bool(got) and got.name.startswith("sweep-"))

print()
print("install-cache.test.py: ALL PASS" if fails == 0 else f"install-cache.test.py: {fails} FAILURE(S)")
raise SystemExit(fails)
