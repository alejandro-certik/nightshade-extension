const assert = require('node:assert/strict');
const vscode = require('vscode');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');

exports.run = async function () {
  const root = await mkdtemp(path.join(tmpdir(), 'nightshade-vscode-smoke-'));
  try {
    const settings = vscode.workspace.getConfiguration('nightshade');
    for (const name of ['scanOnOpen', 'scanWorkspaceOnOpen', 'runOnSave']) {
      await settings.update(name, false, vscode.ConfigurationTarget.Global);
    }
    await vscode.extensions.getExtension('nightshade-local.nightshade-inline').activate();
    await vscode.commands.executeCommand('nightshade.installAnalyzer');
    const file = path.join(root, 'impossible.compact');
    await writeFile(file, 'pragma language_version 0.23;\nexport circuit check(): [] { assert(false, "always fails"); }\n');
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand('nightshade.scanFile');
    assert.ok(vscode.languages.getDiagnostics(document.uri).some(d => d.source === 'Nightshade' && d.code === 'impossible-assertion'),
      'Expected inline impossible-assertion from the installed analyzer');
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0),
      'pragma language_version 0.23;\nexport circuit check(): [] { assert(true, "always passes"); }\n');
    await vscode.workspace.applyEdit(edit);
    await document.save();
    await vscode.commands.executeCommand('nightshade.scanFile');
    assert.equal(vscode.languages.getDiagnostics(document.uri).filter(d => d.source === 'Nightshade').length, 0,
      'Corrected file should clear old inline diagnostics');
    console.log('VS Code integration passed: install command, real Docker scan, inline diagnostic, corrected rescan.');
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await rm(root, { recursive: true, force: true });
  }
};
