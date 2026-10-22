"""Local demo for screenshots: public bank, temporary data, no production connections."""

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8098)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="algoclimb-demo-") as folder:
        root = Path(folder)
        cfg = json.loads((ROOT / "backend/config/config.example.json").read_text())
        cfg.update(
            timeLimits={"choice": 120, "graph": 120},
            revealMs=800,
            paramize={"enabled": False},
            demo={"enabled": False},
            antiCheat={"fastMs": 0, "suspectThreshold": 4},
        )
        (root / "config.json").write_text(json.dumps(cfg))
        (root / "explanations.json").write_text("{}")
        os.environ.update(
            {
                "CONFIG_PATH": str(root / "config.json"),
                "RUNTIME_DIR": str(root / "runtime"),
                "TASK_BANK_PATH": str(ROOT / "backend/data/task-bank.example.json"),
                "EXPLANATIONS_PATH": str(root / "explanations.json"),
                "TEACHER_KEY": "LOCAL-DEMO-ONLY",
                "QR_ROTATION": "0",
                "DEBUG": "0",
                "GSHEETS": "0",
                "PUBLIC_URL": f"http://localhost:{args.port}",
            }
        )
        sys.path.insert(0, str(ROOT / "backend"))
        import uvicorn

        uvicorn.run("main:app", host="127.0.0.1", port=args.port, ws="wsproto")


if __name__ == "__main__":
    main()
