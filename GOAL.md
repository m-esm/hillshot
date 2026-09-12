# GOAL

Two players finish a full match online with bot option on a single domain with revised controls and tank asset.

Play: https://hillshot.46.225.91.43.sslip.io (old `shellshock.` address redirects there).

## Metric

Completed human-vs-human matches recorded by the live server's `humanVsHumanFinished` counter.

## Target

At least **1** completed human-vs-human match.

## Measure

```sh
python3 scripts/measure_hvh.py
```

Pass when the command exits 0 and prints an integer greater than or equal to `1`.

Source: `server/telemetry.js`, `scripts/measure_hvh.py`, and `GET /stats`.
