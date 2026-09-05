---
name: YTSave downloader provider
description: The external YTSave flow needed for cookie-free public YouTube downloads
---

YTSave's public downloader requires a fresh PHP session from its page, a client-side HMAC mint request, and then a `proxy.php` request carrying the minted session value. The provider can still introduce browser verification, rate limits, or endpoint changes.

**Why:** Direct calls without the page session return `STALE_PAGE`, while the intended browser flow can return usable MP4 media URLs without YouTube account cookies.

**How to apply:** Keep YTSave as a provider with timeouts and a fallback rather than treating it as a stable first-party API. Do not store or expose the session cookie or signed media URLs.