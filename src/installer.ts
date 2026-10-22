import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";

const repository = "DicksonWu654/nightshade";
const releaseEndpoint = `https://api.github.com/repos/${repository}/releases/latest`;
const managedPrefix = "nightshade-inline-managed:";

export interface CommandResult { stdout: string; stderr: string; code: number }
export type Runner = (command: string, args: string[], cwd: string, timeout?: number) => Promise<CommandResult>;

export const runCommand: Runner = (command, args, cwd, timeout = 0) => new Promise((resolve, reject) => {
  execFile(command, args, { cwd, timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error && (typeof error.code !== "number" || error.killed || error.signal)) {
      reject(new Error(`${error.message}${stderr ? `\n${stderr}` : ""}`));
    } else {
      resolve({ stdout, stderr, code: typeof error?.code === "number" ? error.code : 0 });
    }
  });
});

export interface ReleaseAsset { name: string; browser_download_url: string; digest?: string }
export interface Release { tag_name: string; draft: boolean; prerelease: boolean; assets: ReleaseAsset[] }
export interface Installation { version: string; image: string; digest: string }
export interface InstallerOptions { docker: string; image: string; autoInstall: boolean }
interface Dependencies {
  run: Runner;
  download: (url: string, limit: number) => Promise<Buffer>;
  progress: <T>(task: () => Promise<T>) => Promise<T>;
  log: (message: string) => void;
}

/** Bounded requests include GitHub's required user agent and time out during body reads too. */
export async function download(url: string, limit: number): Promise<Buffer> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "nightshade-vscode-extension",
      Accept: new URL(url).hostname === "api.github.com" ? "application/vnd.github+json" : "application/octet-stream"
    },
    signal: AbortSignal.timeout(60_000)
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`GitHub download failed (HTTP ${response.status}). ${response.status === 403 || response.status === 429 ? "API rate limit reached; retry later." : "Check your connection and retry."}`);
  }
  if (!response.body) throw new Error("GitHub returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.length;
      if (size > limit) throw new Error("GitHub download exceeds the allowed size.");
      chunks.push(Buffer.from(item.value));
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel();
  }
}

export function selectRelease(value: unknown): { release: Release; asset: ReleaseAsset } {
  const release = value as Release;
  if (!release || release.draft !== false || release.prerelease !== false ||
      !/^v?\d+\.\d+\.\d+$/.test(release.tag_name) || !Array.isArray(release.assets)) {
    throw new Error("GitHub did not return a supported stable Nightshade release.");
  }
  const version = release.tag_name.replace(/^v/, "");
  const assets = release.assets.filter(a => a.name === `nightshade-compact-${version}.tgz`);
  if (assets.length !== 1) throw new Error("The latest Nightshade release has no unique installable npm tarball.");
  assetUrl(release, assets[0]);
  return { release, asset: assets[0] };
}

function assetUrl(release: Release, asset: ReleaseAsset): string {
  const expected = `https://github.com/${repository}/releases/download/${release.tag_name}/${asset.name}`;
  if (asset.browser_download_url !== expected) throw new Error("Unexpected Nightshade release asset URL.");
  return expected;
}

export function verifyChecksum(bytes: Buffer, digest: string): void {
  if (!/^[a-f0-9]{64}$/.test(digest) || createHash("sha256").update(bytes).digest("hex") !== digest) {
    throw new Error("Nightshade SHA-256 verification failed. The download was not installed.");
  }
}

// The upstream tarball includes a Linux x64 grammar prebuild. Debian 13 supplies
// its required libstdc++; npm installs its runtime dependencies inside Docker.
export const dockerfile = `FROM node:24.15.0-trixie-slim
COPY nightshade.tgz /tmp/nightshade.tgz
RUN npm install --global /tmp/nightshade.tgz && rm /tmp/nightshade.tgz
WORKDIR /project
ENTRYPOINT ["nightshade"]
`;

export class NightshadeInstaller {
  private pending = new Map<string, Promise<string>>();
  private dependencies: Dependencies;

  constructor(private storage: string, dependencies: Partial<Dependencies> = {}) {
    this.dependencies = { run: runCommand, download, progress: task => task(), log: () => {}, ...dependencies };
  }

  /** Concurrent workspace/file scans share installation, and failed attempts can be retried. */
  ensure(options: InstallerOptions, update = false): Promise<string> {
    const key = JSON.stringify(options);
    const existing = this.pending.get(key);
    if (existing) return existing;
    const promise = this.resolve(options, update).finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }

  private async resolve(options: InstallerOptions, update: boolean): Promise<string> {
    await mkdir(this.storage, { recursive: true });
    let info: CommandResult;
    try {
      info = await this.dependencies.run(options.docker, ["info", "--format", "{{.OSType}}"], this.storage, 30_000);
    } catch (error) {
      throw new Error(`Docker could not start. Install/start Docker and check nightshade.dockerPath. ${String(error)}`);
    }
    if (info.code !== 0) throw new Error(`Docker is unavailable. Start Docker Desktop or your Docker daemon and retry. ${info.stderr.trim()}`);
    if (info.stdout.trim() !== "linux") throw new Error("Nightshade requires Docker in Linux containers mode.");

    const defaultImage = options.image === "nightshade" || options.image === "nightshade:latest";
    if (!defaultImage) {
      if (update) throw new Error("Switch nightshade.dockerImage to its default to use managed GitHub releases.");
      if (await this.exists(options.docker, options.image)) return options.image;
      throw new Error(`Custom Docker image ${options.image} is missing. Build/pull it, or reset nightshade.dockerImage to enable automatic installation.`);
    }
    if (!update) {
      const cached = await this.cached();
      if (cached && await this.exists(options.docker, cached.image)) return cached.image;
      if (await this.exists(options.docker, options.image)) return options.image;
      if (!options.autoInstall) throw new Error("Nightshade is missing. Enable nightshade.autoInstall or run Nightshade: Install / Update Analyzer.");
    }
    return this.dependencies.progress(() => this.install(options.docker));
  }

  private async exists(docker: string, image: string): Promise<boolean> {
    return (await this.dependencies.run(docker, ["image", "inspect", image], this.storage, 30_000)).code === 0;
  }

  private async cached(): Promise<Installation | undefined> {
    try {
      const value = JSON.parse(await readFile(path.join(this.storage, "installation.json"), "utf8")) as Installation;
      if (/^[a-f0-9]{64}$/.test(value.digest) && value.image === `${managedPrefix}${value.digest}`) return value;
    } catch { /* Absent or corrupt metadata is repaired by the next successful install. */ }
    return undefined;
  }

  private async install(docker: string): Promise<string> {
    const { log, download: get, run } = this.dependencies;
    log(`Looking up the latest stable release from ${repository}…`);
    const { release, asset } = selectRelease(JSON.parse((await get(releaseEndpoint, 2 * 1024 * 1024)).toString("utf8")));
    let digest = asset.digest?.match(/^sha256:([a-f0-9]{64})$/)?.[1];
    if (!digest) {
      const sums = release.assets.find(a => a.name === "SHA256SUMS");
      if (!sums) throw new Error("Nightshade release has no SHA-256 checksum.");
      const text = (await get(assetUrl(release, sums), 64 * 1024)).toString("utf8");
      digest = text.split(/\r?\n/).map(line => line.match(/^([a-f0-9]{64})\s+\*?(.+)$/))
        .find(match => match?.[2] === asset.name)?.[1];
      if (!digest) throw new Error("Nightshade checksum file does not cover the release tarball.");
    }
    const image = `${managedPrefix}${digest}`;
    const staging = await mkdtemp(path.join(this.storage, "install-"));
    try {
      if (!await this.exists(docker, image)) {
        log(`Downloading Nightshade ${release.tag_name}…`);
        const tarball = await get(assetUrl(release, asset), 100 * 1024 * 1024);
        verifyChecksum(tarball, digest);
        await writeFile(path.join(staging, "nightshade.tgz"), tarball);
        await writeFile(path.join(staging, "Dockerfile"), dockerfile);
        log("Checksum verified. Building the Linux x86-64 image (first install can take several minutes)…");
        const result = await run(docker, ["build", "--platform", "linux/amd64", "--tag", image, staging], this.storage, 15 * 60_000);
        if (result.code !== 0) throw new Error(`Nightshade image build failed. Retry Install / Update Analyzer.\n${result.stderr}\n${result.stdout}`);
      }
      log("Checking the installed analyzer…");
      const probe = await run(docker, ["run", "--rm", "--platform", "linux/amd64", "--network", "none", image, "--help"], this.storage, 60_000);
      if (probe.code !== 0) throw new Error(`Nightshade installation check failed: ${probe.stderr}`);
      const installation: Installation = { version: release.tag_name, image, digest };
      await writeFile(path.join(staging, "installation.json"), JSON.stringify(installation));
      await rename(path.join(staging, "installation.json"), path.join(this.storage, "installation.json"));
      log(`Nightshade ${release.tag_name} ready (${image}).`);
      return image;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}
