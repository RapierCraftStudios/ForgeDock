# 5923: WSL mirrored-mode sandbox egress

Status: accepted.

## Problem
On WSL with mirrored networking the guest gets a narrow `ip_local_port_range`, but docker's MASQUERADE picks source ports outside it, so replies are dropped and a sandbox's github.com clone/fetch hangs.

## Decision
- Mirrored stays the default install mode. The agent pins NAT source ports to the guest range (`natPinRules` in `bin/pool/health.mjs`) for every bridge network, idempotently (`iptables -C` before `-I`). It is applied at install (`cs-nat-portrange.service`, After/PartOf/WantedBy `docker.service`, so a docker restart re-runs it) and at every agent start (`wslNetworkFixup`). The script text is generated from one template and asserted identical to the copy in `install-agent.sh`.
- `/health` and `pool status` report `net` (mirrored, port range, pin); mirrored without the pin is degraded.
- A hang that still happens ends `deferred` `sandbox.egress_timeout` (retry in 120 s, never the breaker).

## Alternative evaluated: NAT mode plus portproxy
NAT mode avoids the narrow range (the guest keeps a normal range) but needs a Windows portproxy for the agent's inbound port, loses mirrored's shared LAN/VPN view, and changes an installed host's networking, which needs a WSL restart. It stays available through `install-agent.ps1 -Networking nat` for hosts that want it.

## Not done
The installer default is not flipped: that is a product choice, to be revisited if the pin proves insufficient (post-deploy check `5923-no-egress-timeout-after-pin`).
