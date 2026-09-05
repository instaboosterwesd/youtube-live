---
name: Railway SSH routing
description: Distinguishes the web-terminal proxy from the raw SSH TCP proxy in this environment.
---

The web-terminal endpoint is an HTTP route to ttyd and cannot accept SSH protocol traffic. Replit Shell access requires a separate Railway TCP proxy whose internal target is the container's SSH port.

**Why:** An SSH client reaching the ttyd HTTP endpoint receives a closed connection or HTTP authentication response even though the host and external port are reachable.

**How to apply:** Use the HTTP endpoint only in a browser. For shell access, create/use a TCP mapping to port 22 and connect with `ssh -p <external-port> <user>@<proxy-host>`.