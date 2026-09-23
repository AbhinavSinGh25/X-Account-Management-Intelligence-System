(() => {
  const SCHEMA_VERSION = 3;

  function normalizeUsername(value) {
    if (!value) return "";
    return String(value)
      .trim()
      .replace(/^@/, "")
      .split(/[/?#]/)[0]
      .toLowerCase();
  }

  function normalizePostUrl(value) {
    try {
      const url = new URL(value, location.origin);
      if (url.hostname !== "x.com" && url.hostname !== "www.x.com") return "";
      const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)/i);
      if (!match) return "";
      return `https://x.com/${match[1]}/status/${match[2]}`;
    } catch {
      return "";
    }
  }

  function makeId(prefix) {
    if (globalThis.crypto?.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function makePostId(url) {
    const normalized = normalizePostUrl(url);
    const match = normalized.match(/\/status\/(\d+)/);
    return match ? `post_${match[1]}` : makeId("post");
  }

  function normalizePost(raw = {}) {
    const url = normalizePostUrl(raw.url || raw.postUrl);
    const author = normalizeUsername(raw.author || raw.username);
    if (!url || !author) return null;

    return {
      postId: raw.postId || makePostId(url),
      backendPostId: raw.backendPostId || null,
      author,
      text: String(raw.text || "").slice(0, 5000),
      url,
      createdAt: raw.createdAt || raw.detectedAt || new Date().toISOString()
    };
  }

  function normalizeStatus(raw) {
    if (raw === "CONSIDER_UNFOLLOWING") return "CHECK_FAILED";
    if (["WAITING", "CHECKING", "FOLLOWED_BACK", "NOT_FOLLOWED_BACK", "RETRY_PENDING", "CHECK_FAILED", "UNFOLLOWED"].includes(raw)) {
      return raw;
    }
    return "WAITING";
  }

  function normalizeFollow(raw = {}) {
    const author = normalizeUsername(raw.author || raw.username);
    if (!author) return null;

    const post = normalizePost(raw.post || {});
    return {
      followId: raw.followId || makeId("follow"),
      backendFollowId: raw.backendFollowId || null,
      postId: raw.postId || post?.postId || null,
      author,
      followedAt: raw.followedAt || raw.time || new Date().toISOString(),
      checkedAt: raw.checkedAt || null,
      checkAttempts: Number.isFinite(raw.checkAttempts) ? raw.checkAttempts : 0,
      status: normalizeStatus(raw.status),
      lastCheckResult: raw.lastCheckResult ?? null,
      errorReason: raw.errorReason ?? null,
      followedBack: raw.followedBack === true ? true : raw.followedBack === false ? false : undefined,
      post
    };
  }

  function normalizeState(raw = {}) {
    const detectedPosts = Array.isArray(raw.detectedPosts)
      ? raw.detectedPosts.map(normalizePost).filter(Boolean)
      : [];

    const trackedFollows = Array.isArray(raw.trackedFollows)
      ? raw.trackedFollows.map(normalizeFollow).filter(Boolean)
      : [];

    const pendingChecks = raw.pendingChecks && typeof raw.pendingChecks === "object"
      ? raw.pendingChecks
      : {};

    return {
      schemaVersion: SCHEMA_VERSION,
      detectedPosts,
      trackedFollows,
      pendingChecks
    };
  }

  globalThis.XFIStorage = {
    SCHEMA_VERSION,
    normalizeUsername,
    normalizePostUrl,
    makeId,
    makePostId,
    normalizePost,
    normalizeFollow,
    normalizeState
  };
})();
