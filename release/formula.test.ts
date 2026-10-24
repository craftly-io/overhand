import { expect, test } from "bun:test";
import { formula } from "./formula";

const SUMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]
  .map((p, i) => `${String(i).repeat(64)}  overhand-${p}.tar.gz`)
  .join("\n");

test("the formula names its version, so Homebrew doesn't guess one from a file name like …-arm64.tar.gz", () => {
  const rb = formula("1.2.3", SUMS);
  expect(rb).toContain('  version "1.2.3"');
  expect(rb).toContain("/v1.2.3/overhand-darwin-arm64.tar.gz");
});
