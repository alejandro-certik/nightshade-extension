const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { containerRoot, normalize, quote, scanKey, toHostPath } = require("../out/scan-utils.js");

test("maps scanner paths back into the mounted workspace", () => {
  const root = path.resolve("/tmp", "compact project");
  assert.equal(toHostPath(containerRoot, root), root);
  assert.equal(
    toHostPath("/project/contracts/token.compact", root),
    path.join(root, "contracts", "token.compact")
  );
  assert.equal(toHostPath("/external/library.compact", root), "/external/library.compact");
});

test("creates distinct scan cache keys for workspace and file scans", () => {
  assert.notEqual(scanKey("/workspace", "."), scanKey("/workspace", "contract.compact"));
  assert.equal(scanKey("/workspace", "."), "/workspace\u0000.");
});

test("normalizes platform separators and quotes Docker arguments safely", () => {
  assert.equal(normalize(["contracts", "token.compact"].join(path.sep)), "contracts/token.compact");
  assert.equal(quote("nightshade"), "nightshade");
  assert.equal(quote("/tmp/Compact Project:/project:ro"), "\"/tmp/Compact Project:/project:ro\"");
});
