import * as path from "node:path";

export const containerRoot = "/project";

export function scanKey(hostRoot: string, target: string): string {
  return `${hostRoot}\u0000${target}`;
}

export function toHostPath(scanPath: string, hostRoot: string): string {
  if (scanPath === containerRoot) return hostRoot;
  if (scanPath.startsWith(`${containerRoot}/`)) {
    return path.join(hostRoot, scanPath.slice(containerRoot.length + 1));
  }
  return scanPath;
}

export function normalize(value: string): string {
  return value.split(path.sep).join("/");
}

export function quote(value: string): string {
  return /[\s:]/.test(value) ? JSON.stringify(value) : value;
}
