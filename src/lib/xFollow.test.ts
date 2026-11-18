import assert from "node:assert/strict";
import { X_REDIRECT_URI, xClientIdError, xPostLimitError } from "./xFollow.ts";

assert.equal(X_REDIRECT_URI, "http://127.0.0.1:8737/callback");
assert.equal(xClientIdError("  my-client-id  "), null);
assert.match(
  xClientIdError("super secret token") ?? "",
  /not an access token/,
);
assert.match(xClientIdError("") ?? "", /client ID/);
assert.equal(xPostLimitError(20), null);
assert.match(xPostLimitError(2) ?? "", /5 and 100/);
assert.match(xPostLimitError(500) ?? "", /5 and 100/);
console.log("xFollow.test.ts ok");
