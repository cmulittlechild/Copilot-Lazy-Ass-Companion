#!/usr/bin/env python3
import json
from pathlib import Path
from collections import Counter, defaultdict

root = Path.home() / "Library/Application Support/Code/User/workspaceStorage"
files = sorted(root.glob("*/chatSessions/*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
print("total sessions", len(files))
print("newest5:")
for f in files[:5]:
    print(f.stat().st_mtime, f.name, f.stat().st_size)

part_kinds = Counter()
entry_kinds = Counter()
response_kind_of_entry = Counter()
text_part_shapes = Counter()
samples_by_kind = defaultdict(list)
finalize_keys = Counter()

targets = []
seen = set()
for f in files[:8]:
    if f not in seen:
        seen.add(f)
        targets.append(f)
for f in files:
    if ("eab05fee" in f.name or "aaded402" in f.name) and f not in seen:
        seen.add(f)
        targets.append(f)

for f in targets:
    print("\n===", f.name, "size", f.stat().st_size)
    lines = f.read_text("utf-8", errors="ignore").splitlines()
    for line in lines:
        try:
            o = json.loads(line)
        except Exception:
            continue
        ek = o.get("kind")
        k = o.get("k")
        v = o.get("v")
        i = o.get("i")
        entry_kinds[ek] += 1
        if isinstance(k, list) and len(k) == 3 and k[0] == "requests" and k[2] in ("elapsedMs", "result", "isCanceled"):
            finalize_keys[(ek, k[2])] += 1
        if isinstance(k, list) and len(k) == 3 and k[0] == "requests" and k[2] == "response":
            response_kind_of_entry[(ek, "i" if isinstance(i, int) else "no-i")] += 1
            if isinstance(v, list):
                for p in v:
                    if not isinstance(p, dict):
                        part_kinds["<non-dict>"] += 1
                        continue
                    pk = p.get("kind")
                    if pk is None or pk == "":
                        keys = tuple(sorted(p.keys()))
                        if "value" in p and isinstance(p.get("value"), str):
                            part_kinds["<plain value>"] += 1
                            text_part_shapes[keys] += 1
                            if len(samples_by_kind["<plain value>"]) < 2:
                                samples_by_kind["<plain value>"].append(
                                    {kk: (p[kk] if kk != "value" else str(p[kk])[:80]) for kk in list(p)[:8]}
                                )
                        else:
                            part_kinds[f"<no-kind {keys}>"] += 1
                            if len(samples_by_kind[f"no-kind:{keys}"]) < 1:
                                samples_by_kind[f"no-kind:{keys}"].append(
                                    {kk: str(p[kk])[:80] for kk in list(p)[:10]}
                                )
                    else:
                        part_kinds[str(pk)] += 1
                        if len(samples_by_kind[str(pk)]) < 1:
                            samples_by_kind[str(pk)].append(
                                {
                                    kk: (
                                        str(p[kk])[:120]
                                        if not isinstance(p[kk], (dict, list))
                                        else type(p[kk]).__name__
                                    )
                                    for kk in list(p)[:12]
                                }
                            )

print("\nENTRY kinds", entry_kinds.most_common())
print("RESPONSE entry (kind,i?)", response_kind_of_entry.most_common())
print("FINALIZE markers", finalize_keys.most_common())
print("PART kinds", part_kinds.most_common(50))
print("text shapes", text_part_shapes.most_common(10))
print("\nSAMPLES:")
for k, vs in samples_by_kind.items():
    print("---", k)
    for s in vs:
        print(s)

# post-elapsedMs response arrivals: scan one large session
for f in targets:
    if "eab05fee" not in f.name:
        continue
    lines = f.read_text("utf-8", errors="ignore").splitlines()
    req_state = {}  # idx -> {elapsed: bool, response_after: int, last_event}
    after = 0
    for line in lines:
        try:
            o = json.loads(line)
        except Exception:
            continue
        k = o.get("k")
        if not (isinstance(k, list) and k and k[0] == "requests"):
            continue
        if len(k) == 3 and isinstance(k[1], int):
            idx = k[1]
            st = req_state.setdefault(idx, {"elapsed": False, "resp_after": 0, "parts_after": 0})
            if k[2] in ("elapsedMs", "result", "isCanceled"):
                st["elapsed"] = True
            elif k[2] == "response" and st["elapsed"]:
                st["resp_after"] += 1
                after += 1
                if isinstance(o.get("v"), list):
                    st["parts_after"] += len(o["v"])
    print("\npost-finalize response mutations on eab05fee:", after)
    late = [(i, s) for i, s in req_state.items() if s["resp_after"]]
    print("requests with response after finalize:", late[:10], "count", len(late))
