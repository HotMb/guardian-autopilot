---
name: audit
description: Run a read-only Guardian Autopilot audit of the current project and explain the evidence.
disable-model-invocation: true
---

Run the Guardian Autopilot `plan` command for the current project. Treat its output as review evidence only.

Report exact duplicates, reference evidence, analysis errors, and any unavailable optional analysis. Do not delete, rename, rewrite, or stage files. If the `guardian` command is not installed, explain that the user must build or install Guardian Autopilot first.
