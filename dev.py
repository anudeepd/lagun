#!/usr/bin/env python3
"""Development runner: starts FastAPI + Vite concurrently."""
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).parent
FRONTEND = ROOT / "frontend"


def main():
    os.environ["LAGUN_DEV"] = "1"

    procs = []

    try:
        # Start FastAPI backend
        api_proc = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "lagun.main:app",
             "--reload", "--port", "8000", "--host", "127.0.0.1"],
            cwd=ROOT,
        )
        procs.append(api_proc)
        print("FastAPI started on http://127.0.0.1:8000")

        time.sleep(1)

        # Start Vite frontend dev server
        vite_proc = subprocess.Popen(
            ["npm", "run", "dev"],
            cwd=FRONTEND,
        )
        procs.append(vite_proc)
        print("Vite started on http://127.0.0.1:5173")
        print("\nDev environment ready. Press Ctrl+C to stop.\n")

        # Wait for either process to exit
        while all(p.poll() is None for p in procs):
            time.sleep(0.5)

    except KeyboardInterrupt:
        print("\nShutting down...")
    finally:
        for p in procs:
            try:
                p.terminate()
                p.wait(timeout=5)
            except Exception:
                p.kill()


if __name__ == "__main__":
    main()
