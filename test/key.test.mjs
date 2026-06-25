import test from "node:test";
import assert from "node:assert/strict";
import { validateDeepSeekKey } from "../src/key.mjs";

test("DeepSeek key validation avoids provider-specific overfitting", () => {
  assert.equal(validateDeepSeekKey("sk-short").ok, true);
  assert.equal(validateDeepSeekKey("plain_ascii_token-123").ok, true);
});

test("DeepSeek key validation rejects whitespace and non-ASCII characters", () => {
  assert.equal(validateDeepSeekKey("").reason, "missing");
  assert.equal(validateDeepSeekKey("sk-test bad").reason, "characters");
  assert.equal(validateDeepSeekKey("sk-test\nbad").reason, "characters");
  assert.equal(validateDeepSeekKey("ｓｋ-test").reason, "characters");
});
