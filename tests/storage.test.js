const assert = require("assert");
const { normalizeState, normalizeUsername, cleanupDetectedPosts, safePostUrl } = require("../storage.js");

assert.strictEqual(normalizeUsername(" @Alice_123 "), "alice_123");
assert.strictEqual(safePostUrl("https://x.com/alice/status/123"), true);
assert.strictEqual(safePostUrl("javascript:alert(1)"), false);

const migrated = normalizeState({
  detectedPosts: [{ author: "Alice", url: "https://x.com/Alice/status/123", text: "Let's connect" }],
  trackedFollows: [{ author: "Alice", followedAt: "2026-01-01T00:00:00.000Z", post: { author: "Alice", url: "https://x.com/Alice/status/123" }, status: "CONSIDER_UNFOLLOWING" }],
});
assert.strictEqual(migrated.schemaVersion, 2);
assert.strictEqual(migrated.detectedPosts[0].postId, "123");
assert.ok(migrated.trackedFollows[0].followId);
assert.strictEqual(migrated.trackedFollows[0].status, "CHECK_FAILED");

const oldPost = { postId: "old", author: "alice", url: "https://x.com/alice/status/1", text: "", createdAt: "2020-01-01T00:00:00.000Z" };
const activeFollow = { followId: "f1", postId: "old", author: "alice", status: "WAITING" };
assert.strictEqual(cleanupDetectedPosts([oldPost], [activeFollow], Date.now()).length, 1);
console.log("storage tests passed");

