"""Entry point: `python -m terra_pulse_engine [--host H] [--port P]`.

Electron main spawns this directly. Argument parsing is deliberately tiny —
this is a local, single-user process, not a CLI with an audience.
"""

import argparse

import uvicorn


def main() -> None:
    parser = argparse.ArgumentParser(prog="terra_pulse_engine")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()

    # Bound to localhost only by default and by the --host default above —
    # this process is never meant to be reachable off the local machine.
    uvicorn.run(
        "terra_pulse_engine.api.main:app",
        host=args.host,
        port=args.port,
        log_level="info",
    )


if __name__ == "__main__":
    main()
