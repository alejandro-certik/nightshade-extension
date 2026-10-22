// Opt-in integration: downloads the real latest release and builds/runs Docker.
const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { NightshadeInstaller, runCommand } = require('../out/installer.js');

async function main() {
  const storage = await mkdtemp(path.join(tmpdir(), 'nightshade-live-release-'));
  try {
    const installer = new NightshadeInstaller(storage, { log: console.log });
    // Explicit update exercises real release setup even if a developer has a legacy image.
    const image = await installer.ensure({ docker: 'docker', image: 'nightshade', autoInstall: true }, true);
    const installation = JSON.parse(await readFile(path.join(storage, 'installation.json')));
    console.log('Installed release:', installation.version);
    for (const file of ['contract.compact', 'corrected.compact']) {
      const result = await runCommand('docker', ['run', '--rm', '--platform', 'linux/amd64', '--network', 'none', image,
        '/usr/local/lib/node_modules/nightshade-compact/examples/review/' + file,
        '--detectors', 'ledger-bound-preimage-publication', '--json'], storage, 120000);
      const report = JSON.parse(result.stdout);
      assert.equal(report.status, 'complete', result.stderr);
      assert.equal(result.code, file === 'contract.compact' ? 1 : 0);
      assert.equal(report.findings.length, file === 'contract.compact' ? 1 : 0);
      console.log(file, 'exit', result.code, 'findings', report.findings.length);
    }
    const offline = new NightshadeInstaller(storage, { download: () => { throw Error('Unexpected network request'); } });
    assert.equal(await offline.ensure({ docker: 'docker', image: 'nightshade', autoInstall: true }), image);
    console.log('Release download, image build, positive/negative scans, and offline cache reuse passed.');
  } finally {
    await rm(storage, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
