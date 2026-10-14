# Closed-world proof for CleanCode

Guardian can issue a positive unreachable-file proof only for the opt-in `node-application-v1` profile. The proof means that a supported JavaScript or TypeScript source file is unreachable from every runtime root declared in the tracked repository configuration, in the same clean Git snapshot. It does not establish universal non-use.

## Configure the profile

Add and commit `.guardian/config.json` with every production entry file, such as web server entrypoints, workers, scheduled jobs, and command entrypoints:

```json
{
  "version": 1,
  "protectedPaths": [],
  "ignoredPaths": [],
  "closedWorld": {
    "profile": "node-application-v1",
    "commitment": "all-runtime-roots-declared",
    "entryFiles": ["src/server.ts", "src/worker.ts"]
  }
}
```

This profile is intentionally narrow. It requires a private Node application, a clean Git checkout, tracked files and configuration, regular files without symlinks, explicit roots, resolvable relative imports with explicit extensions, and only the allowlisted `node:` built-ins. External packages and non-empty dependency lists, package scripts, package publication or alias fields, dynamic imports, computed or aliased loaders, constructor/prototype access, reflection APIs, references to ambient runtime roots (`process`, `globalThis`, `global`, `window`, `self`, or `arguments`), unresolved computed property keys, plugin/glob loading, unsupported framework/tool configuration, shell/batch/PowerShell/Python files, and task-runner/workflow command files block proof generation. The profile does not attempt alias or taint analysis: it refuses these ambient roots and recognized loader/reflection APIs wherever they appear, including when the use might be legitimate. `arguments` is blocked because CommonJS wrappers may expose `require` through their argument list.

If a blocker appears, Guardian does not issue a proof. Do not work around a blocker by deleting it from the scan or by relabeling another signal as proof.

## Review and apply

Build and inspect the read-only plan first:

```bash
npm run build:cli
node packages/cli/dist/index.js plan /path/to/project --format=json
```

Create a candidate file containing only the paths you selected after reviewing the plan. The evidence value is required by the file format, but Guardian reruns the trusted analyzer and replaces caller evidence during real apply:

```json
{
  "candidates": [
    { "path": "src/old-module.ts", "evidence": [] }
  ]
}
```

Supply the project's actual build, typecheck, and test commands in a verification file. Then apply only with the per-run confirmation:

```bash
node packages/cli/dist/index.js apply /path/to/project \
  --candidates-file selected-files.json \
  --confirm-closed-world \
  --verification-file checks.json
```

`--confirm-closed-world` records that the user has checked the declared roots for this run; it does not create the proof. The CLI recomputes proof for each selected path, binds it to the Git snapshot, and the executor revalidates the complete snapshot at the isolated-worktree deletion boundary. A serialized positive-proof claim is rejected.

## Limits of the claim

`complete` describes whether this analyzer covered its supported repository snapshot and resolved graph. `unreachable` is relative to the configured roots and this profile. The parser does not emulate arbitrary JavaScript execution or perform general data-flow/taint analysis. It blocks recognized constructor/prototype/reflection APIs, ambient runtime roots, loader-property keys, and unresolved computed property access, but obfuscation through arbitrary encodings, generated code, native extensions, or external runtime injection cannot be ruled out universally. The analyzer also cannot discover consumers in other repositories, external deployment systems, preloads injected by infrastructure, or runtime configuration that is not represented in the scanned tree. The repository owner must account for those uses before applying a deletion. Passing build, typecheck, and test commands is an additional check, not proof of external non-use.

Coverage gaps, zero-coverage files, Knip output, missing import references, and exact hashes do not produce this proof. Licenses and payment behavior are outside this profile.
