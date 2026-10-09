# Nightshade Inline Review

Local VS Code extension that runs the `nightshade` Docker image and presents
Nightshade findings as inline diagnostics for `.compact` files.

## Prerequisites

1. Docker Desktop is running.
2. A local Nightshade image exists. From the Nightshade checkout:

   ```sh
   docker build -t nightshade .
   ```

3. Install `nightshade-inline.vsix` from VS Code's **Extensions: Install from
   VSIX...** command.

## Commands

- **Nightshade: Scan Current Compact File** — scans the active saved `.compact` file.
- **Nightshade: Scan Workspace** — scans all Compact application roots in the active
  workspace, then attaches diagnostics to their source files.
- **Nightshade: Clear Inline Results** — removes all current Nightshade diagnostics.

By default, every opened `.compact` file is scanned and saved `.compact` files
are re-scanned after a short debounce. The scanner reads files from the Docker
mount, so save the editor before scanning.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `nightshade.dockerPath` | `docker` | Docker command/path. |
| `nightshade.dockerImage` | `nightshade` | Local Nightshade image tag. |
| `nightshade.compilerVersion` | `0.31.1` | Analysis profile; match your Compact toolchain. |
| `nightshade.maxPaths` | `1024` | Abstract path limit per rule. |
| `nightshade.maxSteps` | `160000` | Abstract execution step limit per rule. |
| `nightshade.runOnSave` | `true` | Scan saved Compact files. |
| `nightshade.scanWorkspaceOnOpen` | `true` | Scan an opened folder when it contains Compact files. |
| `nightshade.scanOnOpen` | `true` | Scan an opened Compact file when the workspace scan did not cover it. |

The **Nightshade** output channel reports activation, workspace scans, and open-file fallback scans, so it is clear whether analysis ran even when it finds nothing. Results are cached per Compact file. Saving one file always rescans it and replaces only that file’s findings; findings for other files remain visible.

## Interpretation

The extension exposes Nightshade results; it does not make a contract secure.
Review findings and every incomplete-analysis diagnostic. Nightshade scans source
offline and does not compile or execute the contract.

## Development

```sh
npm ci
npm test
npm run package
```

`npm test` compiles the TypeScript and runs the scan-path/cache-key unit tests.
`npm run package` creates `nightshade-inline.vsix`.

## Releases

Pushes and pull requests run the test and packaging workflow. To publish a VSIX,
create and push a tag matching the version in `package.json`, for example:

```sh
git tag v0.1.4
git push origin v0.1.4
```

The workflow creates the corresponding GitHub Release and attaches
`nightshade-inline.vsix`.
