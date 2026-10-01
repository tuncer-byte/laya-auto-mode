"""Re-fit and report the Copilot routing policy on the labelled request set.

Requirements: install laya-mlx with its Copilot router and download both checkpoints.

    python benchmarks/calibrate.py
"""

import argparse
import itertools
import json
import time
from pathlib import Path

from laya_mlx.copilot.policy import Calibration, EditorContext, Signals, compute_effort, tier_for
from laya_mlx.copilot.server import LayaDecider

HERE = Path(__file__).parent
ORDER = {"fast": 0, "balanced": 1, "reasoning": 2}
GRID = {
    "scale": [round(0.8 + 0.1 * index, 2) for index in range(13)],
    "offset": [round(-0.6 + 0.1 * index, 2) for index in range(13)],
    "multi_file": [0.0, 0.3, 0.6, 0.9],
    "deep_reasoning": [0.0, 0.25, 0.5, 0.75],
}


def score(calibration, rows):
    hits = under_routed = 0
    for row in rows:
        effort = compute_effort(row["signals"], EditorContext(), calibration).value
        predicted = tier_for(effort, calibration)
        hits += predicted == row["tier"]
        under_routed += ORDER[predicted] < ORDER[row["tier"]]
    return hits, -under_routed


def fit(rows):
    best, best_score = Calibration(), (-1, 0)
    for values in itertools.product(*GRID.values()):
        calibration = Calibration(**dict(zip(GRID, values)))
        candidate_score = score(calibration, rows)
        if candidate_score > best_score:
            best, best_score = calibration, candidate_score
    return best, best_score


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=HERE / "routing_set.json")
    parser.add_argument("--output", type=Path, default=HERE / "results" / "copilot-routing.json")
    args = parser.parse_args(argv)

    decider = LayaDecider()
    rows = []
    for item in json.loads(args.data.read_text()):
        started = time.perf_counter()
        checkpoint, _reason, answers = decider.signals(item["request"], {})
        rows.append(
            {
                **item,
                "checkpoint": checkpoint,
                "latency_ms": round((time.perf_counter() - started) * 1000, 2),
                "signals": Signals.from_answers(answers),
            }
        )

    report = {"checkpoints": {}}
    for checkpoint in sorted({row["checkpoint"] for row in rows}):
        subset = [row for row in rows if row["checkpoint"] == checkpoint]
        default_hits, _ = score(Calibration(), subset)
        calibration, (hits, _) = fit(subset)
        leave_one_out_hits = sum(
            score(fit(subset[:index] + subset[index + 1 :])[0], [held_out])[0]
            for index, held_out in enumerate(subset)
        )
        report["checkpoints"][checkpoint] = {
            "n": len(subset),
            "calibration": calibration.__dict__,
            "accuracy_default_weights": round(default_hits / len(subset), 4),
            "accuracy_in_sample": round(hits / len(subset), 4),
            "accuracy_leave_one_out": round(leave_one_out_hits / len(subset), 4),
            "rows": [
                {
                    "request": row["request"],
                    "tier": row["tier"],
                    "predicted": tier_for(compute_effort(row["signals"], EditorContext(), calibration).value, calibration),
                    "latency_ms": row["latency_ms"],
                    "signals": row["signals"].__dict__,
                }
                for row in subset
            ],
        }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    print(f"wrote {args.output}")


if __name__ == "__main__":
    main()
