import assert from "node:assert/strict";
import { test } from "node:test";
import { colorEnabled, createFormatter, wrapText } from "../src/cli-format.mjs";

test("colorEnabled stays off unless the stream is a TTY", () => {
  assert.equal(colorEnabled({ isTTY: false }, {}), false);
  assert.equal(colorEnabled({ isTTY: true }, {}), true);
});

test("colorEnabled honors NO_COLOR and DSCB_NO_COLOR", () => {
  assert.equal(colorEnabled({ isTTY: true }, { NO_COLOR: "1" }), false);
  assert.equal(colorEnabled({ isTTY: true }, { DSCB_NO_COLOR: "1" }), false);
  assert.equal(colorEnabled({ isTTY: false }, { FORCE_COLOR: "1" }), true);
});

test("wrapText breaks on word boundaries and keeps blank lines", () => {
  assert.deepEqual(wrapText("one two three", 7), ["one two", "three"]);
  assert.deepEqual(wrapText("a\n\nb", 10), ["a", "", "b"]);
});

test("formatter output is plain ASCII when color is disabled", () => {
  const fmt = createFormatter({ stream: { isTTY: false, columns: 72 }, env: {} });
  const rendered = [fmt.title("Setup"), fmt.section("Bridge", ["ok"]), fmt.box(["hi"], { tone: "red" })].join("\n");
  // No ANSI escape sequences should appear when color is off.
  assert.equal(/\u001b\[/.test(rendered), false);
});

test("box frames content and preserves short indented lines", () => {
  const fmt = createFormatter({ stream: { isTTY: false, columns: 60 }, env: {} });
  const rendered = fmt.box(["Title", "  1. step one"], { tone: "red" });
  const lines = rendered.split("\n");
  assert.match(lines[0], /^\+=+\+$/);
  assert.match(lines.at(-1), /^\+=+\+$/);
  assert.ok(lines.some((line) => line.includes("  1. step one")));
  // Every framed row is the same width.
  const widths = new Set(lines.map((line) => line.length));
  assert.equal(widths.size, 1);
});

test("box wraps lines that exceed the inner width", () => {
  const fmt = createFormatter({ stream: { isTTY: false, columns: 48 }, env: {} });
  const long = "this is a deliberately long sentence that must wrap across several framed rows to fit";
  const rendered = fmt.box([long], { tone: "cyan" });
  const bodyRows = rendered.split("\n").slice(1, -1);
  assert.ok(bodyRows.length > 1);
});
