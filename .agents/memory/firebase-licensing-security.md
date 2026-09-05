---
name: Firebase licensing security
description: Security boundary and generator constraints for the Signal Desk license flow.
---

The current license flow intentionally works against the provided Firebase Realtime Database URL without a service-account credential. With public read/write rules, the owner password protects the app UI/API convention only; it cannot protect the database from direct REST access.

**Why:** The user explicitly chose not to provide a Firebase service-account JSON, so server-side Admin authentication was deferred rather than blocking the requested feature.

**How to apply:** Before production use, add Firebase Authentication or a server-side Admin connection, lock down Realtime Database rules, and move the owner password to a rotatable secret. Re-test license CRUD, renewal, and workspace isolation after hardening.