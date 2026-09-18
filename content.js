console.log("[XFI] content script active");

const connectKeywords = ["let's connect", "lets connect", "looking to connect", "connect with", "grow together", "networking"];
const seenPostIds = new Set();
const listenerTargets = new WeakSet();
let knownPosts = new Map();

function log(event) { console.log(`[XFI] ${event}`); }

function canonicalPostFromArticle(article) {
  const links = [...article.querySelectorAll('a[href*="/status/"]')];
  for (const link of links) {
    const postId = postIdFromUrl(link.href);
    if (!postId) continue;
    try {
      const author = normalizeUsername(new URL(link.href).pathname.split("/")[1]);
      if (!author) continue;
      const text = article.querySelector('[data-testid="tweetText"]')?.innerText || "";
      return { postId, author, url: link.href, text, createdAt: xfiNow() };
    } catch { /* Try the next canonical status link. */ }
  }
  return null;
}

function isNetworkingPost(post) {
  const text = post.text.toLowerCase();
  return connectKeywords.some((keyword) => text.includes(keyword));
}

function followControlInPost(control, article) {
  if (control.closest("article") !== article) return false;
  const testId = (control.getAttribute("data-testid") || "").toLowerCase();
  const aria = (control.getAttribute("aria-label") || "").toLowerCase();
  // X's test id is the primary signal. The labelled-button fallback is deliberately narrow.
  return testId === "follow" || testId.endsWith("-follow") || (control.getAttribute("role") === "button" && aria.startsWith("follow "));
}

function bindFollowControls(article, post) {
  article.querySelectorAll('button, [role="button"]').forEach((control) => {
    if (!followControlInPost(control, article) || listenerTargets.has(control)) return;
    listenerTargets.add(control);
    control.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "TRACK_FOLLOW", postId: post.postId, author: post.author })
        .then((result) => { if (result?.ok && !result.duplicate) log("follow tracked from post context"); })
        .catch(() => log("follow tracking request failed"));
    }, { capture: true });
  });
}

async function rememberNetworkingPost(post) {
  const saved = await chrome.runtime.sendMessage({ type: "SAVE_DETECTED_POST", post });
  if (saved) knownPosts.set(saved.postId, saved);
  return saved;
}

function scanPosts() {
  document.querySelectorAll("article").forEach((article) => {
    const post = canonicalPostFromArticle(article);
    if (!post) return;
    const known = knownPosts.get(post.postId);
    if (known) {
      bindFollowControls(article, known);
      return;
    }
    if (seenPostIds.has(post.postId) || !isNetworkingPost(post)) return;
    seenPostIds.add(post.postId);
    rememberNetworkingPost(post).then((saved) => { if (saved) bindFollowControls(article, saved); }).catch(() => undefined);
  });
}

function profileFollowOutcome() {
  const indicator = document.querySelector('[data-testid="userFollowIndicator"]');
  if (!indicator) return { outcome: "CHECK_FAILED", errorReason: "FOLLOW_INDICATOR_MISSING" };
  const text = indicator.textContent.trim().toLowerCase();
  if (text === "follows you") return { outcome: "FOLLOWED_BACK" };
  if (text === "does not follow you" || text === "not following you") return { outcome: "NOT_FOLLOWED_BACK" };
  return { outcome: "CHECK_FAILED", errorReason: "FOLLOW_INDICATOR_UNRECOGNIZED" };
}

function waitForProfileIndicator(timeout = 5000) {
  return new Promise((resolve) => {
    const check = () => document.querySelector('[data-testid="userFollowIndicator"]');
    if (check()) return resolve(profileFollowOutcome());
    const observer = new MutationObserver(() => {
      if (check()) { observer.disconnect(); resolve(profileFollowOutcome()); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { observer.disconnect(); resolve({ outcome: "CHECK_FAILED", errorReason: "FOLLOW_INDICATOR_TIMEOUT" }); }, timeout);
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "CHECK_FOLLOW_BACK") return;
  waitForProfileIndicator().then(sendResponse).catch(() => sendResponse({ outcome: "CHECK_FAILED", errorReason: "PROFILE_CHECK_EXCEPTION" }));
  return true;
});

chrome.runtime.sendMessage({ type: "GET_STATE" }).then((state) => {
  if (state) knownPosts = new Map(state.detectedPosts.map((post) => [post.postId, post]));
  scanPosts();
  new MutationObserver(scanPosts).observe(document.body, { childList: true, subtree: true });
}).catch(() => log("initial state unavailable"));

