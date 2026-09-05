---
name: YouTube cookie handling
description: Securely handling browser cookies for server-side yt-dlp downloads
---

Browser cookies used to pass YouTube bot checks are credentials. They must not be pasted into chat, committed to GitHub, or stored in Firebase/workspace data. Settings imports should be authenticated and write only to server-side protected storage.

**Why:** A public downloader may need an authenticated browser session when YouTube blocks Railway IPs, but exposing that session can compromise the account.

**How to apply:** Prefer a Railway secret or private mounted file for durable configuration; if a settings import writes to local deployment storage, make the limitation visible and require re-import after filesystem resets.