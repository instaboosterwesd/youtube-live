---
name: YouTube HLS ingest
description: Non-obvious requirements for sending prerecorded video to YouTube HLS ingestion.
---

YouTube HLS ingestion URLs are templates ending in an empty `file=` query parameter. The encoder must use the same endpoint with a concrete playlist filename and concrete segment filenames, sending each playlist and segment with HTTP PUT. The media must be muxed as MPEG-TS with H.264 or HEVC video and AAC audio.

**Why:** A normal HLS output URL or an RTMP-style publish command does not satisfy YouTube’s HLS upload contract.

**How to apply:** When changing the stream runner, preserve the per-file `file=` URL construction, keep `%05d` segment patterns unescaped inside the final `file=` value, and avoid logging the full ingest URL because it contains the stream credential.