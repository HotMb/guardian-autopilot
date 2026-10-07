# Guardian Autopilot | Project brief

## Goal
A developer installs once. Guardian monitors AI-generated projects and safely performs reversible maintenance work automatically where evidence is sufficient; uncertain changes are reported without deletion.

## First customer
Freelance React/Next.js developers using Claude Code; teams and agencies later.

## Distribution
GitHub open-source repository, npm CLI, Claude Code plugin; GitHub App and MCP adapter after reliability validation.

## MVP boundary
1. Local scanning and asset inventory.
2. Accurate detection of exact duplicate assets, unreferenced candidates and unused JS/TS dependencies.
3. Safety policy: scoped, reversible actions; don't touch secrets, migrations, production data, or user-modified/untracked files.
4. Worktree-based repairs, automated checks and rollback.
5. Claude Code post-task trigger with debounce.

## Success criteria
At least 10 consenting repositories audited, measured false positives and validated maintenance minutes saved, 100 weekly active users and 5 paying pilots (targets, not forecasts).

## Out of scope for V1
Deleting assets from ChatGPT/Claude libraries, arbitrary visual similarity deletions, production infrastructure changes, universal multi-language support.
