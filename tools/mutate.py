#!/usr/bin/env python3
"""
A gated hand-plant mutation harness.

Stryker covers everything it can express (see stryker.config.json). This exists
for the mutations it cannot: cross-file plants, whole-file additions, the
source-scanning tests, argv-shape changes, and anything that has to cross a
subprocess boundary (src/cli.ts).

WHY THE GATES EXIST. An ungated hand-plant cannot authenticate its own results,
and both failure modes have really happened in this repository:

  - a plant whose anchor did not match applies nothing, the suite stays green,
    and the harness records SURVIVED for a guard that was never mutated;
  - a plant that applies but does not compile turns the whole suite red, and
    the harness records CAUGHT for a guard that was never exercised.

The rule that follows: A KILL CAN BE SELF-AUTHENTICATING, A SURVIVAL NEVER IS.
A kill quoting a predicted assertion diff from a named test cannot come from
either failure mode, because a non-compiling tree reports a type error instead
of running the assertion and an unmutated tree produces the expected value. So
the six gates below all exist to make a SURVIVED row trustworthy, and a KILLED
row must additionally quote a real assertion diff.

  1. the anchor exists and is UNIQUE before writing
  2. after writing, re-read from disk: the mutated text is present, the anchor
     is gone (unless the mutation deliberately wraps it), and the file changed
  3. the mutant typechecks; non-zero exit is INVALID, never SURVIVED or KILLED
  4. a SPECIFICALLY NAMED test must go red, not "the suite failed"
  5. that red must be an assertion failure, not an import or type error
  6. the baseline is green before AND after the whole run

Five outcomes: KILLED, SURVIVED, INVALID, MISAPPLIED, plus an aborted run when
the baseline is not green.

  python3 tools/mutate.py specs.json

where specs.json is {"files": [test files to run], "mutants": [
  {"label": str,
   "edits":   [[path, anchor, replacement], ...],   # optional
   "creates": [[path, contents], ...],              # optional
   "named":   "<vitest fullName of the test that must go red>",
   "typecheck": true}                               # optional, default true
]}
"""
import subprocess, json, os, sys, shutil, tempfile, signal

ROOT = "/Users/brohm/Documents/Projects/ainews"
os.chdir(ROOT)

def vitest(files, jsonout):
    # start_new_session puts the child in its own process group so a timeout
    # can kill the WHOLE tree. subprocess.run(timeout=) kills only the direct
    # child, which is npx; the vitest worker survives, reparents to PID 1, and
    # keeps running. Four such orphans spun at 100% CPU for five days before
    # anyone noticed, because the harness reported the timeout and moved on.
    proc = subprocess.Popen(
        ["npx", "vitest", "run", "--reporter=json", f"--outputFile={jsonout}", *files],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        proc.communicate(timeout=600)
    except subprocess.TimeoutExpired:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        proc.communicate()
        raise
    try:
        return json.load(open(jsonout))
    except Exception:
        return None

def results(d):
    out = {}
    if not d: return out
    for f in d.get("testResults", []):
        for a in f.get("assertionResults", []):
            name = a.get("fullName") or a.get("title")
            out[name] = (a.get("status"), " ".join(a.get("failureMessages") or []))
    return out

def typecheck():
    return subprocess.run(["npx", "tsc", "--noEmit"], capture_output=True, text=True).returncode

def baseline_green(files):
    r = results(vitest(files, "/tmp/gated-base.json"))
    return r and all(v[0] == "passed" for v in r.values()), len(r or {})

def plant(spec):
    """spec: dict with file/old/new OR create/content OR both."""
    saved = {}
    created = []
    for f, old, new in spec.get("edits", []):
        src = open(f, encoding="utf-8").read()
        n = src.count(old)
        if n == 0:  return None, created, saved, f"anchor absent in {f}"
        if n > 1:   return None, created, saved, f"anchor appears {n} times in {f}, not unique"
        # setdefault, NOT assignment. A mutant with two edits to the SAME file
        # would otherwise snapshot the post-edit-1 text as "pristine" and
        # restore that on the way out, leaving edit 1 applied in the working
        # tree. Measured: that poisoned a run and scored four unrelated mutants
        # INVALID off the corrupted tree, and the "baseline after: GREEN" gate
        # missed it because the baseline runs vitest, which strips types.
        saved.setdefault(f, src)
        open(f, "w", encoding="utf-8").write(src.replace(old, new, 1))
    for f, content in spec.get("creates", []):
        os.makedirs(os.path.dirname(f), exist_ok=True)
        open(f, "w", encoding="utf-8").write(content)
        created.append(f)
    # gate 2: re-read from disk, mutated text present and anchor gone
    for f, old, new in spec.get("edits", []):
        now = open(f, encoding="utf-8").read()
        if new not in now:  return None, created, saved, f"mutated text absent from {f} after write"
        # The anchor must be gone UNLESS the mutation deliberately wraps it
        # (prepend/append forms keep it), in which case the file simply has to
        # have changed.
        if old in now and old not in new:
            return None, created, saved, f"anchor still present in {f} after write"
        if now == saved[f]:
            return None, created, saved, f"{f} is byte-identical after the write"
    for f, _ in spec.get("creates", []):
        if not os.path.exists(f): return None, created, saved, f"{f} was not created"
    return True, created, saved, None

def restore(created, saved):
    for f, src in saved.items():
        open(f, "w", encoding="utf-8").write(src)
    for f in created:
        if os.path.exists(f): os.remove(f)
        d = os.path.dirname(f)
        if os.path.isdir(d) and not os.listdir(d): os.rmdir(d)

def run(spec):
    label, files, named = spec["label"], spec["files"], spec["named"]
    ok, created, saved, why = plant(spec)
    if ok is None:
        restore(created, saved)
        return {"label": label, "outcome": "MISAPPLIED", "detail": why}
    try:
        if spec.get("typecheck", True) and typecheck() != 0:
            return {"label": label, "outcome": "INVALID", "detail": "mutant does not typecheck"}
        r = results(vitest(files, "/tmp/gated-mut.json"))
        if not r:
            return {"label": label, "outcome": "INVALID", "detail": "test run produced no results (import or config error)"}
        hit = r.get(named)
        if hit is None:
            return {"label": label, "outcome": "MISAPPLIED", "detail": f"named test not found: {named}"}
        red = [k for k, v in r.items() if v[0] != "passed"]
        if hit[0] == "passed":
            return {"label": label, "outcome": "SURVIVED", "detail": f"{named} still passes", "red": len(red)}
        msg = hit[1]
        if "AssertionError" not in msg:
            return {"label": label, "outcome": "INVALID", "detail": "red, but not an assertion failure: " + msg.strip().split("\n")[0][:120]}
        diff = next((l.strip() for l in msg.split("\n") if "AssertionError" in l), msg[:160])
        return {"label": label, "outcome": "KILLED", "named": named, "diff": diff[:200], "red": len(red)}
    finally:
        restore(created, saved)

SPECS = json.load(open(sys.argv[1]))
files = SPECS["files"]
green, n = baseline_green(files)
print(f"baseline before: {'GREEN' if green else 'DIRTY'} ({n} tests)")
if not green:
    print("ABORT: baseline not green"); sys.exit(1)
rows = [run({**s, "files": files}) for s in SPECS["mutants"]]
green2, _ = baseline_green(files)
print(f"baseline after : {'GREEN' if green2 else 'DIRTY'}\n")
for r in rows:
    print(f"{r['outcome']:11} | {r['label']}")
    if r.get("diff"): print(f"            | {r['diff']}")
    if r.get("detail"): print(f"            | {r['detail']}")
print("\ncounts:", json.dumps({o: sum(1 for r in rows if r["outcome"] == o) for o in
      ["KILLED","SURVIVED","INVALID","MISAPPLIED"]}))
