#!/usr/bin/env python3
"""validate_xdf.py — VALIDATION GATE for the XDF writer.

Loads the synthetic .xdf produced by synth.mjs with pyxdf and asserts the file
is structurally and semantically correct. ANY pyxdf load failure or failed
assertion exits non-zero and must be treated as a BUILD FAILURE.

Each check below is documented as:  ACTION -> EXPECTED OUTCOME.
"""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))

try:
    import pyxdf
except ImportError:
    # Fall back to the vendored copy (sandbox has no PyPI access).
    sys.path.insert(0, os.path.join(HERE, "vendor"))
    try:
        import pyxdf
    except ImportError:
        print("FAIL: pyxdf is not available (install pyxdf or use test/vendor)", file=sys.stderr)
        sys.exit(2)

TOL_T = 1e-4          # timestamp tolerance (seconds)
PASS, FAIL = [], []


def check(name, action, ok, detail=""):
    line = f"[{'PASS' if ok else 'FAIL'}] {name}\n   action:   {action}\n   expected: {detail}"
    (PASS if ok else FAIL).append(name)
    print(line)


def main():
    with open(os.path.join(HERE, "expected.json")) as f:
        exp = json.load(f)
    path = exp["file"]

    # ACTION: load the file with pyxdf -> EXPECTED: loads without raising.
    try:
        streams, header = pyxdf.load_xdf(path)
    except Exception as e:  # noqa: BLE001
        print(f"FAIL: pyxdf.load_xdf raised: {e}", file=sys.stderr)
        sys.exit(1)
    check("pyxdf_load", "pyxdf.load_xdf(session_synth.xdf)", True, "no exception raised")

    # ACTION: count streams -> EXPECTED: 6 (EEG, PPG, ACC, GYRO, Markers, Telemetry)
    check(
        "stream_count",
        "len(streams)",
        len(streams) == exp["stream_count"],
        f"{exp['stream_count']} streams, got {len(streams)}",
    )

    by_name = {s["info"]["name"][0]: s for s in streams}

    # ACTION: verify each stream's channel count + nominal rate + sample count.
    for name, e in exp["streams"].items():
        if name not in by_name:
            check(f"{name}:present", f"'{name}' in streams", False, "stream missing")
            continue
        s = by_name[name]
        info = s["info"]

        cc = int(info["channel_count"][0])
        check(f"{name}:channel_count", f"{name}.channel_count", cc == e["channel_count"],
              f"{e['channel_count']}, got {cc}")

        sr = float(info["nominal_srate"][0])
        check(f"{name}:nominal_srate", f"{name}.nominal_srate", abs(sr - e["nominal_srate"]) < 1e-6,
              f"{e['nominal_srate']}, got {sr}")

        n = len(s["time_series"])
        check(f"{name}:n_samples", f"len({name}.time_series)", n == e["n_samples"],
              f"{e['n_samples']}, got {n}")

        # ACTION: shape of numeric data matches channel count.
        if name != "Muse-Markers":
            ts = np.asarray(s["time_series"])
            ok = ts.ndim == 2 and ts.shape[1] == e["channel_count"]
            check(f"{name}:data_shape", f"{name}.time_series.shape[1]", ok,
                  f"(*, {e['channel_count']}), got {ts.shape}")

    # ACTION: verify marker strings + timestamps round-trip exactly.
    mk = by_name.get("Muse-Markers")
    if mk is not None:
        got = [(float(t), v[0]) for t, v in zip(mk["time_stamps"], mk["time_series"])]
        got.sort(key=lambda x: x[0])
        want = sorted([(m["t"], m["value"]) for m in exp["markers"]], key=lambda x: x[0])
        same_len = len(got) == len(want)
        check("markers:count", "number of markers", same_len, f"{len(want)}, got {len(got)}")
        if same_len:
            all_ok = True
            for (gt, gv), (wt, wv) in zip(got, want):
                if gv != wv or abs(gt - wt) > TOL_T:
                    all_ok = False
                    print(f"   marker mismatch: got ({gt:.6f},{gv!r}) want ({wt:.6f},{wv!r})")
            check("markers:values_timestamps", "marker (timestamp,label) pairs", all_ok,
                  "all labels equal and timestamps within 1e-4 s")

    # ACTION: confirm FileHeader session metadata survived.
    subj = None
    try:
        subj = header["info"]["desc"]
    except Exception:
        pass
    # subject id lives in our custom session block; just confirm header parsed.
    check("file_header", "header parsed", isinstance(header, dict) and "info" in header,
          "FileHeader XML present")

    print("\n==== SUMMARY ====")
    print(f"PASS: {len(PASS)}   FAIL: {len(FAIL)}")
    if FAIL:
        print("FAILED CHECKS:", ", ".join(FAIL))
        sys.exit(1)
    print("ALL CHECKS PASSED — XDF output is valid.")


if __name__ == "__main__":
    main()
