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

This profile is intentionally narrow. It requires a private Node application, a clean Git checkout, tracked files and configuration, regular files without symlinks, explicit roots, resolvable relative imports with explicit extensions, and only the allowlisted `node:` built-ins. External packages and non-empty dependency lists, package scripts, package publication or alias fields, dynamic imports, computed or aliased loaders, constructor/prototype access, reflection APIs, references to ambient runtime roots (`process`, `globalThis`, `global`, `window`, `self`, or `arguments`), unresolved computed property keys, plugin/glob loading, unsupported framework/tool configuration, shell/batch/PowerShell/Python files, and task-runner/workflow command files block proof generation. The profile also blocks runtime and deployment surfaces it does not parse, including Vercel, Wrangler, Render, Fly, Railway, Netlify, Serverless, Firebase and App Engine configuration; `Procfile`, Docker/Container files, `.npmrc`, `.env*`, `.devcontainer`, `.vscode`, deployment/infrastructure directories, and CI/task configuration. As a generic fallback, every tracked JSON-family file other than `.guardian/config.json`, root `package.json`, `tsconfig.json`, and `jsconfig.json` blocks proof; YAML/YML, TOML, XML, INI, CONF, properties, service, Terraform/HCL files also block proof wherever they appear. This intentionally rejects JSON/YAML/TOML data fixtures and lockfiles too: the analyzer cannot safely distinguish data from configuration without parsing each format.

The profile does not attempt alias or taint analysis: it refuses these ambient roots and recognized loader/reflection APIs wherever they appear, including when the use might be legitimate. `arguments` is blocked because CommonJS wrappers may expose `require` through their argument list. This list covers tracked files discovered in the repository; untracked files, ignored build/dependency directories, platform dashboards, environment settings, preloads, or deployment configuration stored outside this checkout are not visible to the analyzer. The owner must confirm that no such external runtime roots or consumers exist. If that cannot be confirmed, do not use this proof profile for deletion.

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

`complete` describes whether this analyzer covered its supported repository snapshot and resolved graph. `unreachable` is relative to the configured roots and this profile. The parser does not emulate arbitrary JavaScript execution or perform general data-flow/taint analysis. It blocks recognized constructor/prototype/reflection APIs, ambient runtime roots, loader-property keys, unresolved computed property access, and the deployment/configuration formats listed above. Unknown formats or external settings still cannot be proven absent: if the project uses a runtime/deployment configuration surface that is not tracked in one of the blocked files or directories, the owner must stop and treat the analysis as insufficient until that configuration is brought into the repository and modeled. Obfuscation through arbitrary encodings, generated code, native extensions, external runtime injection, consumers in other repositories, platform dashboards, and preloads injected by infrastructure cannot be ruled out universally. Passing build, typecheck, and test commands is an additional check, not proof of external non-use.

Coverage gaps, zero-coverage files, Knip output, missing import references, and exact hashes do not produce this proof. Licenses and payment behavior are outside this profile.
