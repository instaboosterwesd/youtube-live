---
name: Apify YouTube downloader
description: Provider behavior and expiry constraints for the Apify YouTube downloader Actor.
---

The Apify YouTube downloader Actor returns a `downloadedFileUrl` pointing to an Apify key-value-store record. The returned media URL is temporary and may expire in roughly three days, so the API must stream it into local or persistent media storage immediately rather than saving the remote URL as the video's source.

**Why:** The Actor output explicitly warns that its key-value-store file expires, and the application needs a durable playback source for later streaming.

**How to apply:** Use the authenticated Apify connector for both the Actor run and the returned Apify media path, enforce the application's media size limit while streaming, and save the result before returning success to the UI.