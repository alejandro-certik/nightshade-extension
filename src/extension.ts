import * as path from "node:path";
import * as vscode from "vscode";
import { NightshadeInstaller, runCommand } from "./installer";
import { containerRoot, normalize, quote, scanKey, toHostPath } from "./scan-utils";

interface Location {
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

interface Finding {
  detectorId: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  title: string;
  message: string;
  location: Location;
}

interface AnalysisDiagnostic {
  code: string;
  message: string;
  location?: Location;
}

interface ScanResult {
  status: "complete" | "incomplete";
  scanned?: string[];
  findings: Finding[];
  diagnostics: AnalysisDiagnostic[];
}

const source = "Nightshade";

let collection: vscode.DiagnosticCollection;
let output: vscode.OutputChannel;
let installer: NightshadeInstaller;
const pendingScans = new Map<string, NodeJS.Timeout>();
const scanResults = new Map<string, Map<string, vscode.Diagnostic[]>>();
const scanGenerations = new Map<string, number>();
const scannedFiles = new Set<string>();
const workspaceScans = new Map<string, Promise<void>>();
let automaticWorkspaceInitialization: Promise<void> | undefined;

export function activate(context: vscode.ExtensionContext): void {
  collection = vscode.languages.createDiagnosticCollection("nightshade");
  output = vscode.window.createOutputChannel("Nightshade");
  context.subscriptions.push(collection, output);
  output.appendLine("Nightshade extension activated.");
  installer = new NightshadeInstaller(context.globalStorageUri.fsPath, {
    log: message => output.appendLine(message),
    progress: task => Promise.resolve(vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Installing Nightshade from GitHub Releases — see Nightshade output for progress",
      cancellable: false
    }, task))
  });

  context.subscriptions.push(vscode.commands.registerCommand("nightshade.installAnalyzer", async () => {
    if (!vscode.workspace.isTrusted) return;
    output.show(true);
    const config = vscode.workspace.getConfiguration("nightshade");
    try {
      await installer.ensure({
        docker: config.get<string>("dockerPath", "docker"),
        image: config.get<string>("dockerImage", "nightshade"),
        autoInstall: true
      }, true);
      void vscode.window.showInformationMessage("Nightshade is ready. Run Scan Workspace to refresh findings.");
    } catch (error) {
      reportFailure(error);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand("nightshade.scanFile", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isCompact(editor.document)) {
      void vscode.window.showWarningMessage("Open a saved .compact file to run Nightshade.");
      return;
    }
    await scanFile(editor.document.uri, true);
  }));

  context.subscriptions.push(vscode.commands.registerCommand("nightshade.scanWorkspace", async () => {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
      void vscode.window.showWarningMessage("Open a workspace folder to scan with Nightshade.");
      return;
    }
    for (const folder of folders) await scanWorkspaceFolder(folder, true, true);
  }));

  context.subscriptions.push(vscode.commands.registerCommand("nightshade.clearDiagnostics", () => {
    collection.clear();
    scanResults.clear();
    scannedFiles.clear();
    void vscode.window.showInformationMessage("Nightshade inline results cleared.");
  }));

  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(document => {
    if (!isCompact(document) || !setting<boolean>("runOnSave")) return;
    scheduleScan(document.uri);
  }));

  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(document => {
    if (isCompact(document) && setting<boolean>("scanOnOpen")) void ensureFileScanned(document.uri);
  }));

  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(event => {
    for (const folder of event.added) void scanWorkspaceFolder(folder, false, false);
  }));

  automaticWorkspaceInitialization = initializeAutomaticScanning();
  void automaticWorkspaceInitialization;
}

export function deactivate(): void {
  for (const timer of pendingScans.values()) clearTimeout(timer);
}

function isCompact(document: vscode.TextDocument): boolean {
  return document.uri.scheme === "file" && document.fileName.endsWith(".compact");
}

function setting<T>(name: string): T {
  return vscode.workspace.getConfiguration("nightshade").get<T>(name)!;
}

function scheduleScan(uri: vscode.Uri): void {
  const prior = pendingScans.get(uri.fsPath);
  if (prior) clearTimeout(prior);
  pendingScans.set(uri.fsPath, setTimeout(() => {
    pendingScans.delete(uri.fsPath);
    void scanFile(uri, false);
  }, 450));
}

async function initializeAutomaticScanning(): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (setting<boolean>("scanWorkspaceOnOpen")) {
    await Promise.all(folders.map(folder => scanWorkspaceFolder(folder, false, false)));
  } else {
    output.appendLine("Automatic workspace scanning is disabled by nightshade.scanWorkspaceOnOpen.");
  }

  if (setting<boolean>("scanOnOpen")) {
    const documents = vscode.workspace.textDocuments.filter(isCompact);
    output.appendLine(`Open-file fallback: ${documents.length} Compact file(s) checked for coverage.`);
    for (const document of documents) await ensureFileScanned(document.uri, false);
  } else {
    output.appendLine("Open-file fallback is disabled by nightshade.scanOnOpen.");
  }
}

async function scanWorkspaceFolder(folder: vscode.WorkspaceFolder, revealOutput: boolean, force: boolean): Promise<void> {
  const root = folder.uri.fsPath;
  const existing = workspaceScans.get(root);
  if (existing) return existing;

  if (!force) {
    const compactFiles = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, "**/*.compact"),
      new vscode.RelativePattern(folder, "**/{.git,node_modules}/**"),
      1
    );
    if (compactFiles.length === 0) return;
  }

  const promise = scan(root, ".", revealOutput);
  workspaceScans.set(root, promise);
  output.appendLine(`Workspace scan scheduled: ${folder.name}.`);
  try {
    await promise;
  } finally {
    if (workspaceScans.get(root) === promise) workspaceScans.delete(root);
  }
}

async function ensureFileScanned(uri: vscode.Uri, waitForInitialization = true): Promise<void> {
  if (waitForInitialization && automaticWorkspaceInitialization) await automaticWorkspaceInitialization;
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  const root = folder?.uri.fsPath;
  if (root) await workspaceScans.get(root);
  if (!scannedFiles.has(path.resolve(uri.fsPath))) {
    output.appendLine(`Open-file fallback scan scheduled: ${uri.fsPath}.`);
    scheduleScan(uri);
  }
}

async function scanFile(uri: vscode.Uri, revealOutput: boolean): Promise<void> {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  const root = folder?.uri.fsPath ?? path.dirname(uri.fsPath);
  const relative = normalize(path.relative(root, uri.fsPath));
  if (relative.startsWith("../")) {
    await scan(path.dirname(uri.fsPath), path.basename(uri.fsPath), revealOutput);
    return;
  }
  await scan(root, relative, revealOutput);
}

async function scan(hostRoot: string, target: string, revealOutput: boolean): Promise<void> {
  if (!vscode.workspace.isTrusted) return;
  const config = vscode.workspace.getConfiguration("nightshade");
  const docker = config.get<string>("dockerPath", "docker");
  const compilerVersion = config.get<string>("compilerVersion", "0.31.1");
  const maxPaths = config.get<number>("maxPaths", 1024);
  const maxSteps = config.get<number>("maxSteps", 160000);
  const scanArgs = [
    target,
    "--compiler-version", compilerVersion,
    "--max-paths", String(maxPaths),
    "--max-steps", String(maxSteps),
    "--json"
  ];
  const key = scanKey(hostRoot, target);
  const generation = (scanGenerations.get(key) ?? 0) + 1;
  scanGenerations.set(key, generation);

  if (revealOutput) output.show(true);

  try {
    const image = await installer.ensure({
      docker,
      image: config.get<string>("dockerImage", "nightshade"),
      autoInstall: config.get<boolean>("autoInstall", true)
    });
    if (scanGenerations.get(key) !== generation) return;
    const args = ["run", "--rm", "--platform", "linux/amd64", "--network", "none",
      "-v", `${hostRoot}:${containerRoot}:ro`, image, ...scanArgs];
    output.appendLine(`\n$ ${docker} ${args.map(quote).join(" ")}`);
    const { stdout, stderr, code } = await runCommand(docker, args, hostRoot);
    if (![0, 1, 2].includes(code)) throw new Error(`Docker exited ${code}: ${stderr}`);
    if (stderr.trim()) output.appendLine(stderr.trim());
    const result = JSON.parse(stdout) as ScanResult;
    if (scanGenerations.get(key) !== generation) {
      output.appendLine("Discarded stale Nightshade result; a newer scan is already running.");
      return;
    }
    recordCoverage(result, hostRoot, target);
    publish(result, hostRoot, key, target);
    output.appendLine(`Nightshade ${result.status}: ${result.findings.length} finding(s), ${result.diagnostics.length} diagnostic(s). Exit ${code}.`);

    if (result.status === "incomplete") {
      void vscode.window.showWarningMessage("Nightshade analysis is incomplete. Review the Problems panel and Nightshade output.");
    } else if (revealOutput) {
      void vscode.window.showInformationMessage(`Nightshade complete: ${result.findings.length} finding(s).`);
    }
  } catch (error) {
    reportFailure(error);
  }
}

function reportFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  output.appendLine(`Nightshade failed: ${message}`);
  void vscode.window.showErrorMessage(`Nightshade: ${message.split("\n")[0]}`, "Show Output").then(action => {
    if (action) output.show(true);
  });
}

function publish(result: ScanResult, hostRoot: string, key: string, target: string): void {
  const groups = new Map<string, vscode.Diagnostic[]>();
  const add = (file: string, diagnostic: vscode.Diagnostic): void => {
    const key = toHostPath(file, hostRoot);
    groups.set(key, [...(groups.get(key) ?? []), diagnostic]);
  };

  for (const finding of result.findings) {
    const diagnostic = new vscode.Diagnostic(toRange(finding.location), `${finding.title}: ${finding.message}`, severity(finding.severity));
    diagnostic.source = source;
    diagnostic.code = finding.detectorId;
    add(finding.location.file, diagnostic);
  }

  for (const item of result.diagnostics) {
    const diagnostic = new vscode.Diagnostic(item.location ? toRange(item.location) : new vscode.Range(0, 0, 0, 1), item.message, vscode.DiagnosticSeverity.Warning);
    diagnostic.source = source;
    diagnostic.code = item.code;
    add(item.location?.file ?? hostRoot, diagnostic);
  }

  const previous = scanResults.get(key) ?? new Map<string, vscode.Diagnostic[]>();
  const targetFile = target === "." ? undefined : path.resolve(hostRoot, target);
  if (targetFile) groups.set(targetFile, groups.get(targetFile) ?? []);

  const affectedFiles = new Set([...previous.keys(), ...groups.keys()]);
  if (target === ".") {
    for (const [otherKey, otherResults] of scanResults) {
      if (otherKey !== key && otherKey.startsWith(`${hostRoot}\u0000`)) {
        for (const file of otherResults.keys()) affectedFiles.add(file);
        scanResults.delete(otherKey);
      }
    }
  } else {
    for (const [otherKey, otherResults] of scanResults) {
      if (otherKey === key) continue;
      for (const file of groups.keys()) {
        if (otherResults.delete(file)) affectedFiles.add(file);
      }
    }
  }
  scanResults.set(key, groups);

  for (const file of affectedFiles) {
    const diagnostics = [...scanResults.values()].flatMap(result => result.get(file) ?? []);
    const uri = vscode.Uri.file(file);
    if (diagnostics.length === 0) collection.delete(uri);
    else collection.set(uri, diagnostics);
  }
}

function recordCoverage(result: ScanResult, hostRoot: string, target: string): void {
  if (target === ".") {
    for (const file of [...scannedFiles]) {
      if (file === hostRoot || file.startsWith(`${hostRoot}${path.sep}`)) scannedFiles.delete(file);
    }
  }

  for (const file of result.scanned ?? []) scannedFiles.add(path.resolve(toHostPath(file, hostRoot)));
  if (target !== ".") scannedFiles.add(path.resolve(hostRoot, target));
}

function toRange(location: Location): vscode.Range {
  const startLine = Math.max(0, location.line - 1);
  const startColumn = Math.max(0, location.column - 1);
  const endLine = Math.max(startLine, (location.endLine ?? location.line) - 1);
  const endColumn = Math.max(startColumn + 1, (location.endColumn ?? location.column + 1) - 1);
  return new vscode.Range(startLine, startColumn, endLine, endColumn);
}

function severity(value: Finding["severity"]): vscode.DiagnosticSeverity {
  if (value === "critical" || value === "high") return vscode.DiagnosticSeverity.Error;
  if (value === "medium" || value === "low") return vscode.DiagnosticSeverity.Warning;
  return vscode.DiagnosticSeverity.Information;
}

