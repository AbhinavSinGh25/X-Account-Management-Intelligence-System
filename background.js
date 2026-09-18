importScripts("storage.js");

const CHECK_TIMEOUT_MINUTES = 0.5;
let mutationQueue = Promise.resolve();

const storageGet = (keys) => chrome.storage.local.get(keys);
const storageSet = (value) => chrome.storage.local.set(value);
const alarmCreate = (name, info) => chrome.alarms.create(name, info);
const alarmClear = (name) => chrome.alarms.clear(name);
const tabRemove = (tabId) => chrome.tabs.remove(tabId).catch(() => undefined);

function log(event, detail = "") {
  console.log(`[XFI] ${event}${detail ? `: ${detail}` : ""}`);
}

function checkAlarmName(followId) { return `xfi:check:${followId}`; }
function timeoutAlarmName(followId) { return `xfi:timeout:${followId}`; }

function mutateState(mutator) {
  const task = mutationQueue.then(async () => {
    const raw = await storageGet(["schemaVersion", "detectedPosts", "trackedFollows", "pendingChecks"]);
    const state = normalizeState(raw);
    const result = await mutator(state);
    state.detectedPosts = cleanupDetectedPosts(state.detectedPosts, state.trackedFollows);
    await storageSet(state);
    return result;
  });
  mutationQueue = task.catch(() => undefined);
  return task;
}

async function getState() {
  return normalizeState(await storageGet(["schemaVersion", "detectedPosts", "trackedFollows", "pendingChecks"]));
}

async function scheduleFollowCheck(followId) {
  await alarmCreate(checkAlarmName(followId), { delayInMinutes: 0.5 });
}

async function cleanupCheck(followId) {
  const state = await getState();
  const pending = state.pendingChecks[followId];
  await Promise.all([alarmClear(timeoutAlarmName(followId)), alarmClear(checkAlarmName(followId))]);
  if (pending?.tabId) await tabRemove(pending.tabId);
  await mutateState((latest) => { delete latest.pendingChecks[followId]; });
}

async function finishCheck(followId, outcome, errorReason = null) {
  const checkedAt = xfiNow();
  let shouldRetry = false;
  await mutateState((state) => {
    const follow = state.trackedFollows.find((item) => item.followId === followId);
    if (!follow) return;
    follow.checkedAt = checkedAt;
    follow.lastCheckResult = outcome;
    follow.errorReason = errorReason;
    if (outcome === "FOLLOWED_BACK" || outcome === "NOT_FOLLOWED_BACK") {
      follow.status = outcome;
    } else {
      follow.status = follow.checkAttempts < 2 ? "RETRY_PENDING" : "CHECK_FAILED";
      shouldRetry = follow.status === "RETRY_PENDING";
    }
  });
  await cleanupCheck(followId);
  if (shouldRetry) await scheduleFollowCheck(followId);
  log("check finished", outcome);
}

async function failCheck(followId, reason) {
  await finishCheck(followId, "CHECK_FAILED", reason);
}

async function beginCheck(followId) {
  const follow = await mutateState((state) => {
    const item = state.trackedFollows.find((record) => record.followId === followId);
    if (!item || !["WAITING", "RETRY_PENDING"].includes(item.status)) return null;
    item.status = "CHECKING";
    item.checkAttempts += 1;
    item.lastCheckResult = "CHECKING";
    item.errorReason = null;
    state.pendingChecks[followId] = { followId, tabId: null, startedAt: xfiNow(), messageSent: false };
    return { ...item };
  });
  if (!follow) return;
  try {
    const tab = await chrome.tabs.create({ url: `https://x.com/${follow.author}`, active: false });
    await mutateState((state) => {
      if (state.pendingChecks[followId]) state.pendingChecks[followId].tabId = tab.id;
    });
    await alarmCreate(timeoutAlarmName(followId), { delayInMinutes: CHECK_TIMEOUT_MINUTES });
    log("check tab opened");
    if (tab.status === "complete") await requestProfileCheck(followId, tab.id);
  } catch (error) {
    await failCheck(followId, "TAB_CREATION_FAILED");
  }
}

async function requestProfileCheck(followId, tabId) {
  const state = await getState();
  const pending = state.pendingChecks[followId];
  const follow = state.trackedFollows.find((item) => item.followId === followId);
  if (!pending || pending.tabId !== tabId || pending.messageSent || !follow) return;
  await mutateState((latest) => {
    if (latest.pendingChecks[followId]) latest.pendingChecks[followId].messageSent = true;
  });
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "CHECK_FOLLOW_BACK", followId, author: follow.author });
    if (!response?.outcome) throw new Error("NO_RESPONSE");
    if (["FOLLOWED_BACK", "NOT_FOLLOWED_BACK"].includes(response.outcome)) {
      await finishCheck(followId, response.outcome);
    } else {
      await failCheck(followId, response.errorReason || "CHECK_UNCONFIRMED");
    }
  } catch (error) {
    await failCheck(followId, "CONTENT_SCRIPT_UNAVAILABLE");
  }
}

async function recoverPendingChecks() {
  const state = await getState();
  await Promise.all(state.trackedFollows
    .filter((follow) => ["WAITING", "RETRY_PENDING"].includes(follow.status))
    .map(async (follow) => {
      const alarm = await chrome.alarms.get(checkAlarmName(follow.followId));
      if (!alarm) await scheduleFollowCheck(follow.followId);
    }));
  await Promise.all(Object.values(state.pendingChecks).map(async (pending) => {
    const follow = state.trackedFollows.find((item) => item.followId === pending.followId);
    if (!follow || follow.status !== "CHECKING") return cleanupCheck(pending.followId);
    if (pending.tabId) {
      try {
        await chrome.tabs.get(pending.tabId);
      } catch {
        await failCheck(pending.followId, "CHECK_TAB_CLOSED");
      }
    }
  }));
}

function initializeStorage() {
  return mutateState(() => undefined).then(recoverPendingChecks);
}

chrome.runtime.onInstalled.addListener(() => { initializeStorage().catch(() => undefined); });
chrome.runtime.onStartup.addListener(() => { initializeStorage().catch(() => undefined); });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_STATE") {
    getState().then(sendResponse).catch(() => sendResponse(null));
    return true;
  }
  if (message.type === "SAVE_DETECTED_POST") {
    mutateState((state) => {
      const post = normalizePost(message.post);
      if (!post || state.detectedPosts.some((item) => item.postId === post.postId)) return null;
      state.detectedPosts.push(post);
      return post;
    }).then(sendResponse).catch(() => sendResponse(null));
    return true;
  }
  if (message.type === "TRACK_FOLLOW") {
    mutateState((state) => {
      const post = state.detectedPosts.find((item) => item.postId === message.postId);
      const author = normalizeUsername(message.author);
      if (!post || post.author !== author) return { ok: false, reason: "UNVERIFIED_ATTRIBUTION" };
      const existing = state.trackedFollows.find((item) => item.postId === post.postId && item.author === author);
      if (existing) return { ok: true, follow: existing, duplicate: true };
      const follow = {
        followId: createStableId("follow"), postId: post.postId, author,
        followedAt: xfiNow(), checkedAt: null, checkAttempts: 0,
        status: "WAITING", lastCheckResult: "PENDING", errorReason: null,
      };
      state.trackedFollows.push(follow);
      return { ok: true, follow, duplicate: false };
    }).then(async (result) => {
      if (result?.ok && !result.duplicate) await scheduleFollowCheck(result.follow.followId);
      sendResponse(result);
    }).catch(() => sendResponse({ ok: false, reason: "STORAGE_FAILED" }));
    return true;
  }
  if (message.type === "RETRY_FOLLOW_CHECK" && message.followId) {
    mutateState((state) => {
      const follow = state.trackedFollows.find((item) => item.followId === message.followId);
      if (follow?.status === "RETRY_PENDING") follow.status = "WAITING";
      return follow;
    }).then((follow) => follow && scheduleFollowCheck(follow.followId)).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith("xfi:check:")) beginCheck(alarm.name.slice("xfi:check:".length)).catch(() => undefined);
  if (alarm.name.startsWith("xfi:timeout:")) failCheck(alarm.name.slice("xfi:timeout:".length), "CHECK_TIMEOUT").catch(() => undefined);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  getState().then((state) => {
    const pending = Object.values(state.pendingChecks).find((item) => item.tabId === tabId);
    if (pending) return requestProfileCheck(pending.followId, tabId);
  }).catch(() => undefined);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  getState().then((state) => {
    const pending = Object.values(state.pendingChecks).find((item) => item.tabId === tabId);
    if (pending) return failCheck(pending.followId, "CHECK_TAB_CLOSED");
  }).catch(() => undefined);
});

