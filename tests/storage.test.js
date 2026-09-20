const assert = require("assert");

globalThis.location = { origin: "https://x.com" };
globalThis.crypto = require("crypto").webcrypto;

require("../storage.js");

const s = globalThis.XFIStorage;

assert.equal(s.normalizeUsername("@AbC"), "abc");
assert.equal(
  s.normalizePostUrl("https://x.com/AbC/status/12345"),
  "https://x.com/AbC/status/12345"
);
assert.equal(
  s.normalizePostUrl("https://example.com/abc/status/12345"),
  ""
);

const legacy = s.normalizeFollow({
  author: "@User",
  followedAt: "2026-01-01T00:00:00.000Z",
  status: "CONSIDER_UNFOLLOWING",
  post: {
    author: "@User",
    url: "https://x.com/User/status/12345",
    text: "Let's connect"
  }
});

assert.equal(legacy.author, "user");
assert.equal(legacy.status, "CHECK_FAILED");
assert.ok(legacy.followId);
assert.equal(legacy.postId, "post_12345");

console.log("storage tests passed");
