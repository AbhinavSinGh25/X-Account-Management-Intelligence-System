importScripts("./storage.js");

const API_BASE_URL = "http://localhost:3000";
const DEV_USER_ID = "e44dc489-5017-43eb-9bb7-6325aebd2ab8";
const CHECK_DELAY_MINUTES = 0.5; // 30 seconds for development
const MAX_CHECK_ATTEMPTS = 3;
const STORAGE_KEYS = ["schemaVersion", "detectedPosts", "trackedFollows", "pendingChecks"];

let mutationQueue = Promise.resolve();

function queueMutation(task) {
  const run = mutationQueue.then(task, task);
  mutationQueue = run.catch(() => {});
  return run;
}

function getState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEYS, (result) => {
      if (chrome.runtime.lastError) {
        resolve(XFIStorage.normalizeState({}));
        return;
      }
      resolve(XFIStorage.normalizeState(result));
    });
  });
}

function setState(state) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(state, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

async function apiRequest(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `API request failed: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function ensureBackendPost(post) {
  if (post.backendPostId) return post.backendPostId;

  const xPostId = post.postId.replace(/^post_/, "");

  try {
    const existing = await apiRequest(
      `/api/posts/by-x-id/${encodeURIComponent(xPostId)}?user_id=${encodeURIComponent(DEV_USER_ID)}`
    );
    return existing.post.id;
  } catch (error) {
    if (error.status !== 404) throw error;
  }

  const created = await apiRequest("/api/posts", {
    method: "POST",
    body: JSON.stringify({
      user_id: DEV_USER_ID,
      x_post_id: xPostId,
      author_x_user_id: post.author,
      author_username: post.author,
      post_url: post.url,
      post_text: post.text,
    }),
  });

  return created.post.id;
}

async function ensureBackendFollow(follow, backendPostId) {
  if (follow.backendFollowId) return follow.backendFollowId;

  try {
    const existing = await apiRequest(
      `/api/follows/by-x-user-id/${encodeURIComponent(follow.author)}?user_id=${encodeURIComponent(DEV_USER_ID)}`
    );
    return existing.follow.id;
  } catch (error) {
    if (error.status !== 404) throw error;
  }

  const created = await apiRequest("/api/follows", {
    method: "POST",
    body: JSON.stringify({
      user_id: DEV_USER_ID,
      x_user_id: follow.author,
      username: follow.author,
      source_post_id: backendPostId,
    }),
  });

  return created.follow.id;
}

async function syncPostToBackend(post) {
  const backendPostId = await ensureBackendPost(post);

  await queueMutation(async () => {
    const state = await getState();
    const index = state.detectedPosts.findIndex((item) => item.postId === post.postId);
    if (index >= 0) {
      state.detectedPosts[index].backendPostId = backendPostId;
      await setState(state);
    }
  });

  console.log("[XFI] Post synced to backend:", post.postId);
  return backendPostId;
}

async function saveDetectedPost(rawPost) {
  const post = XFIStorage.normalizePost(rawPost);
  if (!post) return;

  await queueMutation(async () => {
    const state = await getState();
    const existing = state.detectedPosts.findIndex((p) => p.postId === post.postId);
    if (existing >= 0) {
      state.detectedPosts[existing] = { ...state.detectedPosts[existing], ...post };
    } else {
      state.detectedPosts.push(post);
    }

    const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
    const activePostIds = new Set(
      state.trackedFollows
        .filter((f) => ["WAITING", "CHECKING", "RETRY_PENDING"].includes(f.status))
        .map((f) => f.postId)
        .filter(Boolean)
    );

    state.detectedPosts = state.detectedPosts
      .filter((p) => activePostIds.has(p.postId) || Date.parse(p.createdAt) >= cutoff)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, 300);

    await setState(state);
  });

  try {
    await syncPostToBackend(post);
  } catch (error) {
    console.error("[XFI] Failed to sync post:", error);
  }
}

async function trackFollow(rawFollow) {
  const follow = XFIStorage.normalizeFollow(rawFollow);
  if (!follow) return;

  await queueMutation(async () => {
    const state = await getState();

    if (state.trackedFollows.some((item) => item.followId === follow.followId)) return;

    const sameActiveAuthor = state.trackedFollows.find(
      (item) => item.author === follow.author && ["WAITING", "CHECKING", "RETRY_PENDING"].includes(item.status)
    );
    if (sameActiveAuthor) return;

    const post = state.detectedPosts.find((item) => item.postId === follow.postId) || follow.post;
    if (!post) {
      console.error("[XFI] Follow has no source post:", follow.author);
      return;
    }

    let backendPostId;
    try {
      backendPostId = await ensureBackendPost(post);
    } catch (error) {
      console.error("[XFI] Failed to sync source post before follow:", error);
      return;
    }

    let backendFollowId;
    try {
      backendFollowId = await ensureBackendFollow(follow, backendPostId);
    } catch (error) {
      console.error("[XFI] Failed to sync follow:", error);
      return;
    }

    follow.backendFollowId = backendFollowId;
    follow.post = { ...post, backendPostId };

    state.trackedFollows.push(follow);
    await setState(state);

    const alarmName = createAlarmName(follow.followId);
    await chrome.alarms.clear(alarmName);

    state.pendingChecks[follow.followId] = {
      followId: follow.followId,
      author: follow.author,
      createdAt: new Date().toISOString(),
      attempts: 0,
      tabId: null,
    };

    await setState(state);
    chrome.alarms.create(alarmName, { delayInMinutes: CHECK_DELAY_MINUTES });

    console.log("[XFI] Follow synced to backend:", follow.author, backendFollowId);
  });
}

function createAlarmName(followId) {
  return `xfi_check_${followId}`;
}

async function updateFollow(followId, patch) {
  return queueMutation(async () => {
    const state = await getState();
    const index = state.trackedFollows.findIndex((f) => f.followId === followId);
    if (index < 0) return null;
    state.trackedFollows[index] = { ...state.trackedFollows[index], ...patch };
    await setState(state);
    return state.trackedFollows[index];
  });
}

async function removePendingCheck(followId) {
  return queueMutation(async () => {
    const state = await getState();
    delete state.pendingChecks[followId];
    await setState(state);
  });
}

async function getPendingCheck(followId) {
  const state = await getState();
  return state.pendingChecks[followId] || null;
}

async function getFollow(followId) {
  const state = await getState();
  return state.trackedFollows.find((f) => f.followId === followId) || null;
}

async function syncFollowCheck(followId, status, attempt, error = null) {
  const follow = await getFollow(followId);
  if (!follow?.backendFollowId) {
    console.error("[XFI] Missing backend follow ID; cannot sync check:", followId);
    return;
  }

  try {
    await apiRequest("/api/follow-checks", {
      method: "POST",
      body: JSON.stringify({
        follow_id: follow.backendFollowId,
        status,
        attempt,
        error,
      }),
    });
    console.log("[XFI] Follow check synced:", followId, status);
  } catch (syncError) {
    console.error("[XFI] Failed to sync follow check:", syncError);
  }
}

async function syncFollowUnfollowed(follow) {
  if (!follow?.backendFollowId) {
    console.error("[XFI] Missing backend follow ID; cannot sync unfollow:", follow?.followId);
    return;
  }

  try {
    await apiRequest("/api/follows/unfollow", {
      method: "POST",
      body: JSON.stringify({
        follow_id: follow.backendFollowId,
      }),
    });
    console.log("[XFI] Unfollow synced:", follow.followId);
  } catch (error) {
    console.error("[XFI] Failed to sync unfollow:", error);
  }
}

async function markFollowUnfollowed(username) {
  const normalizedUsername = XFIStorage.normalizeUsername(username);
  if (!normalizedUsername) {
    console.warn("[XFI] Unfollow detected but username could not be resolved.");
    return;
  }

  const result = await queueMutation(async () => {
    const state = await getState();
    const candidates = state.trackedFollows
      .map((follow, index) => ({ follow, index }))
      .filter(({ follow }) =>
        follow.author === normalizedUsername &&
        follow.status !== "UNFOLLOWED"
      )
      .sort(
        (a, b) =>
          Date.parse(b.follow.followedAt || "") -
          Date.parse(a.follow.followedAt || "")
      );

    const candidate = candidates[0];
    if (!candidate) return null;

    const follow = { ...candidate.follow };
    const pending = state.pendingChecks[follow.followId];

    const updated = {
      ...follow,
      status: "UNFOLLOWED",
      followedBack: undefined,
      checkedAt: new Date().toISOString(),
      lastCheckResult: "UNFOLLOWED",
      errorReason: null,
    };

    state.trackedFollows[candidate.index] = updated;
    delete state.pendingChecks[follow.followId];
    await setState(state);

    return { follow: updated, tabId: pending?.tabId ?? null };
  });

  if (!result) return;

  await chrome.alarms.clear(createAlarmName(result.follow.followId));

  if (result.tabId != null) {
    chrome.tabs.remove(result.tabId, () => void chrome.runtime.lastError);
  }

  console.log("[XFI] Follow marked UNFOLLOWED:", result.follow.author);
  await syncFollowUnfollowed(result.follow);
}

async function handleCheckAlarm(followId) {
  const pending = await getPendingCheck(followId);
  if (!pending) return;

  const follow = await getFollow(followId);
  if (!follow) {
    await removePendingCheck(followId);
    return;
  }

  if (["FOLLOWED_BACK", "NOT_FOLLOWED_BACK", "CHECK_FAILED", "UNFOLLOWED"].includes(follow.status)) {
    await removePendingCheck(followId);
    return;
  }

  const attempts = Number(pending.attempts || 0) + 1;
  const latestBeforeCheck = await getFollow(followId);
  if (!latestBeforeCheck || latestBeforeCheck.status === "UNFOLLOWED") {
    await cleanupCheck(followId);
    return;
  }

  await updateFollow(followId, {
    status: "CHECKING",
    checkAttempts: attempts,
    checkedAt: new Date().toISOString(),
  });

  await queueMutation(async () => {
    const state = await getState();
    if (state.pendingChecks[followId]) {
      state.pendingChecks[followId].attempts = attempts;
      await setState(state);
    }
  });

  chrome.tabs.create(
    { url: `https://x.com/${encodeURIComponent(follow.author)}`, active: false },
    async (tab) => {
      if (chrome.runtime.lastError || !tab?.id) {
        await handleCheckFailure(followId, "TAB_CREATE_FAILED", attempts);
        return;
      }

      const latestAfterTabCreate = await getFollow(followId);
      const latestPending = await getPendingCheck(followId);
      if (!latestAfterTabCreate || latestAfterTabCreate.status === "UNFOLLOWED" || !latestPending) {
        await cleanupCheck(followId, tab.id);
        return;
      }

      await queueMutation(async () => {
        const current = await getState();
        if (!current.pendingChecks[followId]) return;
        current.pendingChecks[followId].tabId = tab.id;
        await setState(current);
      });

      const latestBeforeProfileCheck = await getFollow(followId);
      if (!latestBeforeProfileCheck || latestBeforeProfileCheck.status === "UNFOLLOWED") {
        await cleanupCheck(followId, tab.id);
        return;
      }

      if (tab.status === "complete") checkProfileTab(tab.id, followId);
    }
  );
}

async function checkProfileTab(tabId, followId) {
  const currentFollow = await getFollow(followId);
  if (!currentFollow || currentFollow.status === "UNFOLLOWED") {
    await cleanupCheck(followId, tabId);
    return;
  }

  chrome.tabs.sendMessage(tabId, { type: "CHECK_FOLLOW_BACK", followId }, async (response) => {
    if (chrome.runtime.lastError) {
      await handleCheckFailure(followId, "CONTENT_SCRIPT_UNAVAILABLE", null, tabId);
      return;
    }

    if (!response || response.result === "UNKNOWN") {
      await handleCheckFailure(followId, response?.errorReason || "UNKNOWN_CHECK_RESULT", null, tabId);
      return;
    }

    const follow = await getFollow(followId);
    if (!follow) {
      await handleCheckFailure(followId, "FOLLOW_NOT_FOUND", null, tabId);
      return;
    }

    if (follow.status === "UNFOLLOWED") {
      await cleanupCheck(followId, tabId);
      return;
    }

    const status = response.result;
    if (status === "FOLLOWED_BACK" || status === "NOT_FOLLOWED_BACK") {
      const applied = await queueMutation(async () => {
        const state = await getState();
        const index = state.trackedFollows.findIndex((item) => item.followId === followId);
        if (index < 0) return null;

        const latest = state.trackedFollows[index];
        if (latest.status === "UNFOLLOWED") return null;

        const updated = {
          ...latest,
          status,
          followedBack: status === "FOLLOWED_BACK",
          checkedAt: new Date().toISOString(),
          lastCheckResult: status,
          errorReason: null,
        };
        state.trackedFollows[index] = updated;
        await setState(state);
        return updated;
      });

      if (!applied) {
        await cleanupCheck(followId, tabId);
        return;
      }

      await syncFollowCheck(followId, status, applied.checkAttempts || 1);
      await cleanupCheck(followId, tabId);
      return;
    }

    await handleCheckFailure(followId, "UNRECOGNIZED_CHECK_RESULT", null, tabId);
  });
}

async function handleCheckFailure(followId, reason, attemptsOverride, tabId) {
  const pending = await getPendingCheck(followId);
  const currentFollow = await getFollow(followId);

  if (!currentFollow || currentFollow.status === "UNFOLLOWED") {
    await cleanupCheck(followId, tabId);
    return;
  }

  const attempts = attemptsOverride ?? Number(pending?.attempts || 1);

  if (attempts < MAX_CHECK_ATTEMPTS) {
    const applied = await queueMutation(async () => {
      const state = await getState();
      const index = state.trackedFollows.findIndex((item) => item.followId === followId);
      if (index < 0 || state.trackedFollows[index].status === "UNFOLLOWED") return false;

      state.trackedFollows[index] = {
        ...state.trackedFollows[index],
        status: "RETRY_PENDING",
        checkedAt: new Date().toISOString(),
        lastCheckResult: "CHECK_FAILED",
        errorReason: reason,
        checkAttempts: attempts,
      };

      if (state.pendingChecks[followId]) {
        state.pendingChecks[followId].attempts = attempts;
        state.pendingChecks[followId].tabId = null;
      }

      await setState(state);
      return true;
    });

    if (!applied) {
      await cleanupCheck(followId, tabId);
      return;
    }

    const alarmName = createAlarmName(followId);
    await chrome.alarms.clear(alarmName);
    chrome.alarms.create(alarmName, { delayInMinutes: CHECK_DELAY_MINUTES });
  } else {
    const applied = await queueMutation(async () => {
      const state = await getState();
      const index = state.trackedFollows.findIndex((item) => item.followId === followId);
      if (index < 0 || state.trackedFollows[index].status === "UNFOLLOWED") return false;

      state.trackedFollows[index] = {
        ...state.trackedFollows[index],
        status: "CHECK_FAILED",
        checkedAt: new Date().toISOString(),
        lastCheckResult: "CHECK_FAILED",
        errorReason: reason,
        checkAttempts: attempts,
      };
      await setState(state);
      return true;
    });

    if (!applied) {
      await cleanupCheck(followId, tabId);
      return;
    }

    await syncFollowCheck(followId, "CHECK_FAILED", attempts, reason);
    await cleanupCheck(followId, tabId);
  }

  if (tabId) chrome.tabs.remove(tabId, () => void chrome.runtime.lastError);
}

async function cleanupCheck(followId, tabId = null) {
  const pending = await getPendingCheck(followId);
  const actualTabId = tabId ?? pending?.tabId;

  await chrome.alarms.clear(createAlarmName(followId));
  await removePendingCheck(followId);

  if (actualTabId != null) chrome.tabs.remove(actualTabId, () => void chrome.runtime.lastError);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type) return;

  if (message.type === "DETECTED_POST") {
    saveDetectedPost(message.post)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === "FOLLOW_TRACKED") {
    trackFollow(message.follow)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === "FOLLOW_UNFOLLOWED") {
    markFollowUnfollowed(message.username)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith("xfi_check_")) return;
  const followId = alarm.name.replace("xfi_check_", "");
  handleCheckAlarm(followId).catch((error) => console.error("[XFI] Alarm check failed:", error));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  getState().then((state) => {
    const pending = Object.values(state.pendingChecks).find((item) => item.tabId === tabId);
    if (pending) checkProfileTab(tabId, pending.followId);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  getState().then(async (state) => {
    const pending = Object.values(state.pendingChecks).find((item) => item.tabId === tabId);
    if (!pending) return;
    await handleCheckFailure(pending.followId, "CHECK_TAB_CLOSED", pending.attempts, null);
  });
});

chrome.runtime.onStartup.addListener(recoverPendingChecks);
chrome.runtime.onInstalled.addListener(recoverPendingChecks);

async function recoverPendingChecks() {
  const state = await getState();

  for (const pending of Object.values(state.pendingChecks)) {
    const follow = state.trackedFollows.find((f) => f.followId === pending.followId);
    if (!follow) {
      await removePendingCheck(pending.followId);
      continue;
    }

    if (["FOLLOWED_BACK", "NOT_FOLLOWED_BACK", "CHECK_FAILED", "UNFOLLOWED"].includes(follow.status)) {
      await cleanupCheck(pending.followId, pending.tabId);
      continue;
    }

    const alarmName = createAlarmName(pending.followId);
    const existing = await chrome.alarms.get(alarmName);
    if (!existing) chrome.alarms.create(alarmName, { delayInMinutes: CHECK_DELAY_MINUTES });
  }
}
