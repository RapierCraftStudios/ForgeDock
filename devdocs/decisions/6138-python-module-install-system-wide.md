# 6138: generic python installs go system-wide, not --user

Decision: `genericInstallCommands` installs a missing python module into the interpreter the validate runs: `pip install --break-system-packages` (no `--user`), then plain pip, then the distro `python3-<module>` package (APT_PY map kept); non-root runs through sudo. `python3 -I` ignores user site-packages, so `--user` made the probe pass while the run failed.

When a pre-PR check still fails on `No module named X`, the engine installs X once system-wide and reruns; if it still fails the lane ends `env.tool_missing`, never `ci.red`.
