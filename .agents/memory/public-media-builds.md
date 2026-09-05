---
name: Public media builds
description: How to keep clean public repository builds independent of local video assets
---

Ignored local media must not be statically imported by a frontend build. Public releases should use runtime uploads, downloads, or API-served media instead.

**Why:** A clean GitHub checkout does not contain ignored video files, and Vite fails during bundling when a static asset import points at one of those files.

**How to apply:** Keep demo media optional at build time, avoid importing ignored files through Vite aliases, and let users add server-ready media through the application flow.