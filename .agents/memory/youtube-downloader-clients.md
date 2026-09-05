---
name: YouTube downloader clients
description: Compatibility behavior for YouTube downloads in the local media downloader
---

Some publicly watchable YouTube videos can be rejected by yt-dlp's default player client with an “not available on this app” error, while the Android player client still exposes downloadable formats.

**Why:** YouTube client availability and playback responses vary by video; relying only on the default client made an otherwise valid video fail.

**How to apply:** Keep the downloader's Android player-client extractor fallback enabled, and treat private, age-restricted, region-restricted, or newly blocked videos as expected failure cases.