importScripts("./storage.js");
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

function createAlarmName(followId) {
  return `xfi_check_${followId}`;
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

    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
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
}

async function trackFollow(rawFollow) {
  const follow = XFIStorage.normalizeFollow(rawFollow);
  if (!follow) return;

  await queueMutation(async () => {
    const state = await getState();

    const existing = state.trackedFollows.find(
      (item) => item.followId === follow.followId
    );

    if (existing) return;

    const sameActiveAuthor = state.trackedFollows.find(
      (item) =>
        item.author === follow.author &&
        ["WAITING", "CHECKING", "RETRY_PENDING"].includes(item.status)
    );

    if (sameActiveAuthor) {
      return;
    }

    state.trackedFollows.push(follow);
    await setState(state);

    const alarmName = createAlarmName(follow.followId);
    await chrome.alarms.clear(alarmName);

    state.pendingChecks[follow.followId] = {
      followId: follow.followId,
      author: follow.author,
      createdAt: new Date().toISOString(),
      attempts: 0,
      tabId: null
    };

    await setState(state);

    chrome.alarms.create(alarmName, {
      delayInMinutes: CHECK_DELAY_MINUTES
    });
  });
}

async function updateFollow(followId, patch) {
  return queueMutation(async () => {
    const state = await getState();
    const index = state.trackedFollows.findIndex((f) => f.followId === followId);
    if (index < 0) return null;

    state.trackedFollows[index] = {
      ...state.trackedFollows[index],
      ...patch
    };

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

async function handleCheckAlarm(followId) {
  const pending = await getPendingCheck(followId);
  if (!pending) {
    return;
  }

  const state = await getState();
  const follow = state.trackedFollows.find((f) => f.followId === followId);
  if (!follow) {
    await removePendingCheck(followId);
    return;
  }

  if (follow.status === "FOLLOWED_BACK") {
    await removePendingCheck(followId);
    return;
  }

  const attempts = Number(pending.attempts || 0) + 1;

  await updateFollow(followId, {
    status: "CHECKING",
    checkAttempts: attempts,
    checkedAt: new Date().toISOString()
  });

  await queueMutation(async () => {
    const current = await getState();
    if (current.pendingChecks[followId]) {
      current.pendingChecks[followId].attempts = attempts;
      await setState(current);
    }
  });

  chrome.tabs.create(
    {
      url: `https://x.com/${encodeURIComponent(follow.author)}`,
      active: false
    },
    async (tab) => {
      if (chrome.runtime.lastError || !tab?.id) {
        await handleCheckFailure(followId, "TAB_CREATE_FAILED", attempts);
        return;
      }

      await queueMutation(async () => {
        const current = await getState();
        if (!current.pendingChecks[followId]) return;
        current.pendingChecks[followId].tabId = tab.id;
        await setState(current);
      });

      if (tab.status === "complete") {
        checkProfileTab(tab.id, followId);
      }
    }
  );
}

function checkProfileTab(tabId, followId) {
  chrome.tabs.sendMessage(
    tabId,
    {
      type: "CHECK_FOLLOW_BACK",
      followId
    },
    async (response) => {
      if (chrome.runtime.lastError) {
        await handleCheckFailure(
          followId,
          "CONTENT_SCRIPT_UNAVAILABLE",
          null,
          tabId
        );
        return;
      }

      if (!response || response.result === "UNKNOWN") {
        await handleCheckFailure(
          followId,
          response?.errorReason || "UNKNOWN_CHECK_RESULT",
          null,
          tabId
        );
        return;
      }

      if (response.result === "FOLLOWED_BACK") {
        await updateFollow(followId, {
          status: "FOLLOWED_BACK",
          followedBack: true,
          checkedAt: new Date().toISOString(),
          lastCheckResult: "FOLLOWED_BACK",
          errorReason: null
        });
        await cleanupCheck(followId, tabId);
        return;
      }

      if (response.result === "NOT_FOLLOWED_BACK") {
        await updateFollow(followId, {
          status: "NOT_FOLLOWED_BACK",
          followedBack: false,
          checkedAt: new Date().toISOString(),
          lastCheckResult: "NOT_FOLLOWED_BACK",
          errorReason: null
        });
        await cleanupCheck(followId, tabId);
        return;
      }

      await handleCheckFailure(
        followId,
        "UNRECOGNIZED_CHECK_RESULT",
        null,
        tabId
      );
    }
  );
}

async function handleCheckFailure(followId, reason, attemptsOverride, tabId) {
  const pending = await getPendingCheck(followId);
  const attempts = attemptsOverride ?? Number(pending?.attempts || 1);

  if (attempts < MAX_CHECK_ATTEMPTS) {
    await updateFollow(followId, {
      status: "RETRY_PENDING",
      checkedAt: new Date().toISOString(),
      lastCheckResult: "CHECK_FAILED",
      errorReason: reason,
      checkAttempts: attempts
    });

    await queueMutation(async () => {
      const state = await getState();
      if (state.pendingChecks[followId]) {
        state.pendingChecks[followId].attempts = attempts;
        state.pendingChecks[followId].tabId = null;
        await setState(state);
      }
    });

    const alarmName = createAlarmName(followId);
    await chrome.alarms.clear(alarmName);
    chrome.alarms.create(alarmName, {
      delayInMinutes: CHECK_DELAY_MINUTES
    });
  } else {
    await updateFollow(followId, {
      status: "CHECK_FAILED",
      checkedAt: new Date().toISOString(),
      lastCheckResult: "CHECK_FAILED",
      errorReason: reason,
      checkAttempts: attempts
    });
    await cleanupCheck(followId, tabId);
  }

  if (tabId) {
    chrome.tabs.remove(tabId, () => void chrome.runtime.lastError);
  }
}

async function cleanupCheck(followId, tabId = null) {
  const pending = await getPendingCheck(followId);
  const actualTabId = tabId ?? pending?.tabId;

  await chrome.alarms.clear(createAlarmName(followId));
  await removePendingCheck(followId);

  if (actualTabId != null) {
    chrome.tabs.remove(actualTabId, () => void chrome.runtime.lastError);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type) return;

  if (message.type === "DETECTED_POST") {
    saveDetectedPost(message.post)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        sendResponse({ ok: false });
      });
    return true;
  }

  if (message.type === "FOLLOW_TRACKED") {
    trackFollow(message.follow)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        sendResponse({ ok: false });
      });
    return true;
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith("xfi_check_")) return;
  const followId = alarm.name.replace("xfi_check_", "");
  handleCheckAlarm(followId).catch((error) => {
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;

  getState().then((state) => {
    const pending = Object.values(state.pendingChecks).find(
      (item) => item.tabId === tabId
    );
    if (pending) checkProfileTab(tabId, pending.followId);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  getState().then(async (state) => {
    const pending = Object.values(state.pendingChecks).find(
      (item) => item.tabId === tabId
    );
    if (!pending) return;

    await handleCheckFailure(
      pending.followId,
      "CHECK_TAB_CLOSED",
      pending.attempts,
      null
    );
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

    if (["FOLLOWED_BACK", "NOT_FOLLOWED_BACK", "CHECK_FAILED"].includes(follow.status)) {
      await cleanupCheck(pending.followId, pending.tabId);
      continue;
    }

    const alarmName = createAlarmName(pending.followId);
    const existing = await chrome.alarms.get(alarmName);

    if (!existing) {
      chrome.alarms.create(alarmName, {
        delayInMinutes: CHECK_DELAY_MINUTES
      });
    }
  }
}
