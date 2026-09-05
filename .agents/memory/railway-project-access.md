---
name: Railway project access
description: Railway CLI authentication and project-creation constraints in this workspace
---

Railway CLI may report a successful login while `railway status` has no linked project and `railway list` shows no projects. Creating a project in the Personal workspace can fail with an upgrade requirement.

**Why:** Deployment cannot proceed until the user supplies an existing accessible project or makes a workspace eligible to create one.

**How to apply:** Check `railway status` and `railway list` before configuring variables or running `railway up`; do not assume login means a deployable project exists.