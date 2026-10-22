# Nightshade Inline Review

VS Code extension that runs the Nightshade analyzer through Docker and presents
Nightshade findings as inline diagnostics for `.compact` files.

## Prerequisites

1. Install and start Docker Desktop (Linux containers), or a Linux Docker daemon.
2. Install `nightshade-inline.vsix` from VS Code's **Extensions: Install from
   VSIX...** command.
3. Open a trusted folder containing Compact files. If Nightshade is missing,
   the extension installs it automatically and continues the scan.

## Automatic analyzer installation

On first use, the default image setting reuses an installed managed release or
an existing local `nightshade` image. When neither exists, the extension resolves
the **latest stable release** from
[DicksonWu654/nightshade](https://github.com/DicksonWu654/nightshade/releases/latest),
downloads its npm tarball, verifies its SHA-256 checksum, and installs it inside
a Docker image. A VS Code progress notification and the **Nightshade** output
channel show setup progress. Internet access to GitHub, Docker Hub, and npm is
needed during installation; the initial image build can take several minutes.

The public tarball currently targets Linux x86-64. All scans use `linux/amd64`
containers, including on Apple Silicon. Docker remains required; you do not
need Node.js, npm, or a Nightshade source checkout on your host. In Remote SSH,
WSL, or Dev Containers, Docker must be accessible from the extension host there.

Release metadata lives in VS Code's extension `globalStorageUri`; temporary
downloads are removed after installation and the image is cached by Docker.
Subsequent scans reuse that image without checking GitHub, and run with network
access disabled. Concurrent requests within an extension host share installation.
Use **Nightshade: Install / Update Analyzer** to explicitly fetch the latest
stable release later; a failed update preserves the previous installation.
Old managed images remain available in Docker until you remove them yourself.

Set `nightshade.autoInstall` to `false` to disable automatic downloads. A custom
`nightshade.dockerImage` is always respected and must be built/pulled manually.
Reset it to `nightshade` to enable managed releases. If installation fails, check
the Output channel, start Docker/check connectivity, then retry the install command.

## Commands

- **Nightshade: Install / Update Analyzer** — install the latest stable GitHub release.
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
| `nightshade.autoInstall` | `true` | Install the latest stable release when the default image is missing. |
| `nightshade.dockerPath` | `docker` | Docker command/path. |
| `nightshade.dockerImage` | `nightshade` | Managed/default image, or an explicitly installed custom image. |
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

`npm test` compiles TypeScript and tests installation, checksums, failure/retry,
cache reuse, concurrent requests, process errors, and scan-path/cache-key handling.
`npm run package` creates `nightshade-inline.vsix`.

`npm run test:release` is an opt-in integration test requiring Docker and network
access. It downloads the real latest release, builds the managed image, scans
the upstream positive and negative examples, and verifies offline cache reuse.
It leaves the managed image cached in Docker and removes its temporary files.

The VS Code extension-host suite is `test/vscode/suite.cjs`. Run VS Code with
`--extensionDevelopmentPath` pointing to this checkout, `--extensionTestsPath`
pointing to that suite, and a disposable `--user-data-dir`. It installs/updates
the analyzer, checks an inline finding from a real Docker scan, and verifies that
rescanning corrected code clears the diagnostic. Docker and network are required.

## Releases

Pushes and pull requests run the test and packaging workflow. To publish a VSIX,
create and push a tag matching the version in `package.json`, for example:

```sh
git tag v0.1.4
git push origin v0.1.4
```

The workflow creates the corresponding GitHub Release and attaches
`nightshade-inline.vsix`.
