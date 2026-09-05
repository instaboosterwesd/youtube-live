---
name: Railway Railpack runtime packages
description: Configuring Python and media binaries in Railway's current Railpack runtime
---

Current Railway Railpack builds may ignore `nixpacks.toml` when selecting runtime packages. Use the repository's `railpack.json` deploy apt package configuration for binaries such as `python3` and `ffmpeg`; keep `nixpacks.toml` only as a fallback for Nixpacks-based builds.

**Why:** The Node service's bundled `yt-dlp` launcher uses `#!/usr/bin/env python3`, and a Railpack runtime with only Node can fail with `env: 'python3': No such file or directory`.

**How to apply:** When a Railway Node deployment shells out to Python or media tools, configure the required runtime packages in `railpack.json`, redeploy, and exercise the real endpoint rather than validating only the JavaScript build.