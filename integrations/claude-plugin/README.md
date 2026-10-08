# Guardian Autopilot plugin for Claude Code

This plugin adds two read-only entry points:

- `/guardian-autopilot:audit` runs an explicit `guardian plan` audit.
- A `Stop` hook runs the same plan after Claude finishes responding, at most once every five minutes per project.

The hook never deletes, renames, stages, or writes to the project. Its debounce state is stored in the operating system temporary directory. If Guardian is not available on `PATH`, the hook exits quietly so it cannot block Claude Code.

## Try it locally

From the repository root:

```bash
claude plugin validate ./integrations/claude-plugin
claude --plugin-dir ./integrations/claude-plugin
```

Then invoke `/guardian-autopilot:audit` in the Claude Code session. The hook uses `CLAUDE_PROJECT_DIR` as the project root and expects the `guardian` executable to be available on `PATH`.

For development or package-manager installs, set `GUARDIAN_COMMAND` to the Guardian executable. The optional `GUARDIAN_HOOK_DEBOUNCE_MS` environment variable changes the five-minute default. `GUARDIAN_COMMAND_ARGS` can provide a JSON array of command arguments when wrapping Guardian in another executable; the project root is appended automatically.

This integration does not create a permanent background process. Claude Code invokes the hook only for the lifecycle event while the plugin is loaded.
