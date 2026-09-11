#!/usr/bin/env python3
"""Print humanVsHumanFinished from live Hillshot /stats. One number, exit 0."""
import json
import sys
import urllib.request

URL = "https://hillshot.46.225.91.43.sslip.io/stats"


def main() -> int:
    try:
        with urllib.request.urlopen(URL, timeout=20) as resp:
            data = json.load(resp)
    except Exception as exc:
        sys.stderr.write("could not run: fetch %s - %s\n" % (URL, exc))
        return 1
    print(int(data.get("humanVsHumanFinished") or 0))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
