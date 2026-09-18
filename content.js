console.log("[XFI] content script active");

const connectKeywords = ["let's connect", "lets connect", "looking to connect", "connect with", "grow together", "networking"];
const seenPostIds = new Set();
const listenerTargets = new WeakSet();
const FOLLOW_CONTEXT_WINDOW_MS = 8000;
let knownPosts = new Map();
let pendingFollowContext = null;

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

function isAuthorProfileLink(link, author) {
  try {
    const parsed = new URL(link.href);
    return parsed.hostname === "x.com" && normalizeUsername(parsed.pathname.split("/")[1]) === author;
  } catch {
    return false;
  }
}

function armFollowContext(post) {
  pendingFollowContext = { postId: post.postId, author: post.author, expiresAt: Date.now() + FOLLOW_CONTEXT_WINDOW_MS };
}

function contextMatchesControl(control, context) {
  let scope = control;
  // X hover cards and profile headers are often detached from the original article.
  // Require a matching profile link in the control's own rendered context before tracking.
  for (let depth = 0; scope && depth < 6; depth += 1, scope = scope.parentElement) {
    const links = scope.querySelectorAll?.('a[href]') || [];
    if ([...links].some((link) => isAuthorProfileLink(link, context.author))) return true;
  }
  return false;
}

function requestTracking(post) {
  chrome.runtime.sendMessage({ type: "TRACK_FOLLOW", postId: post.postId, author: post.author })
    .then((result) => { if (result?.ok && !result.duplicate) log("follow tracked from post context"); })
    .catch(() => log("follow tracking request failed"));
}

function bindFollowControls(article, post) {
  article.querySelectorAll('button, [role="button"]').forEach((control) => {
    if (!followControlInPost(control, article) || listenerTargets.has(control)) return;
    listenerTargets.add(control);
    control.addEventListener("click", () => requestTracking(post), { capture: true });
  });
}

function bindAuthorLinks(article, post) {
  article.querySelectorAll('a[href]').forEach((link) => {
    if (!isAuthorProfileLink(link, post.author) || listenerTargets.has(link)) return;
    listenerTargets.add(link);
    link.addEventListener("click", () => armFollowContext(post), { capture: true });
  });
}

document.addEventListener("click", (event) => {
  const context = pendingFollowContext;
  if (!context || Date.now() > context.expiresAt) {
    pendingFollowContext = null;
    return;
  }
  const control = event.target.closest?.('button, [role="button"]');
  if (!control || !followControlInPost(control, control.closest("article")) || !contextMatchesControl(control, context)) return;
  pendingFollowContext = null;
  requestTracking(context);
}, { capture: true });

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
      bindAuthorLinks(article, known);
      return;
    }
    if (seenPostIds.has(post.postId) || !isNetworkingPost(post)) return;
    seenPostIds.add(post.postId);
    rememberNetworkingPost(post).then((saved) => {
      if (!saved) return;
      bindFollowControls(article, saved);
      bindAuthorLinks(article, saved);
    }).catch(() => undefined);
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

