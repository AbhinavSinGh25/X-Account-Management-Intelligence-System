const XFI_SCHEMA_VERSION = 2;
const XFI_ACTIVE_STATUSES = new Set(["WAITING", "CHECKING", "RETRY_PENDING"]);
const XFI_DETECTED_POST_LIMIT = 300;
const XFI_DETECTED_POST_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function xfiNow() {
  return new Date().toISOString();
}

function normalizeUsername(value) {
  return String(value || "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 15);
}

function postIdFromUrl(url) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/([^/]+)\/status\/([0-9]+)/i);
    return match ? match[2] : null;
  } catch {
    return null;
  }
}

function createStableId(prefix) {
  if (globalThis.crypto?.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function legacyStatus(record) {
  if (record.status === "FOLLOWED_BACK" || record.followedBack === true) {
    return "FOLLOWED_BACK";
  }
  if (record.status === "WAITING") return "WAITING";
  if (["CHECKING", "NOT_FOLLOWED_BACK", "CHECK_FAILED", "RETRY_PENDING"].includes(record.status)) {
    return record.status;
  }
  return "CHECK_FAILED";
}

function normalizePost(record, now = xfiNow()) {
  const url = String(record?.url || "");
  const postId = String(record?.postId || postIdFromUrl(url) || "");
  const author = normalizeUsername(record?.author);
  if (!postId || !author || !url) return null;
  return {
    postId,
    author,
    url,
    text: String(record?.text || ""),
    createdAt: record?.createdAt || now,
  };
}

function normalizeFollow(record, postsById, now = xfiNow()) {
  const author = normalizeUsername(record?.author || record?.post?.author);
  const legacyPost = normalizePost(record?.post, now);
  const postId = String(record?.postId || legacyPost?.postId || "");
  if (!author || !postId) return null;
  return {
    followId: record?.followId || createStableId("follow"),
    postId,
    author,
    followedAt: record?.followedAt || record?.time || now,
    checkedAt: record?.checkedAt || null,
    checkAttempts: Number.isInteger(record?.checkAttempts) ? record.checkAttempts : 0,
    status: legacyStatus(record),
    lastCheckResult: record?.lastCheckResult || (record?.followedBack === true ? "FOLLOWED_BACK" : "UNKNOWN"),
    errorReason: record?.errorReason || (record?.status === "CONSIDER_UNFOLLOWING" ? "LEGACY_UNCONFIRMED_RESULT" : null),
  };
}

function cleanupDetectedPosts(posts, follows, nowMs = Date.now()) {
  const referenced = new Set(
    follows.filter((follow) => XFI_ACTIVE_STATUSES.has(follow.status)).map((follow) => follow.postId),
  );
  const recent = posts
    .filter((post) => {
      const age = nowMs - Date.parse(post.createdAt);
      return referenced.has(post.postId) || (!Number.isNaN(age) && age <= XFI_DETECTED_POST_MAX_AGE_MS);
    })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const kept = [];
  for (const post of recent) {
    if (kept.length < XFI_DETECTED_POST_LIMIT || referenced.has(post.postId)) kept.push(post);
  }
  return kept;
}

function normalizeState(raw = {}) {
  const now = xfiNow();
  const posts = [];
  const postIds = new Set();
  for (const record of Array.isArray(raw.detectedPosts) ? raw.detectedPosts : []) {
    const post = normalizePost(record, now);
    if (post && !postIds.has(post.postId)) {
      postIds.add(post.postId);
      posts.push(post);
    }
  }
  const postsById = new Map(posts.map((post) => [post.postId, post]));
  const follows = [];
  const followIds = new Set();
  for (const record of Array.isArray(raw.trackedFollows) ? raw.trackedFollows : []) {
    const follow = normalizeFollow(record, postsById, now);
    if (follow && !followIds.has(follow.followId)) {
      followIds.add(follow.followId);
      follows.push(follow);
    }
  }
  return {
    schemaVersion: XFI_SCHEMA_VERSION,
    detectedPosts: cleanupDetectedPosts(posts, follows),
    trackedFollows: follows,
    pendingChecks: raw.pendingChecks && typeof raw.pendingChecks === "object" ? raw.pendingChecks : {},
  };
}

function safePostUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "x.com" && /^\/[^/]+\/status\/[0-9]+/.test(url.pathname);
  } catch {
    return false;
  }
}

if (typeof module !== "undefined") {
  module.exports = { XFI_SCHEMA_VERSION, XFI_ACTIVE_STATUSES, normalizeUsername, postIdFromUrl, normalizeState, cleanupDetectedPosts, safePostUrl };
}

