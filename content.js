const connectKeywords = [
  "let's connect",
  "lets connect",
  "looking to connect",
  "connect with",
  "grow together",
  "networking"
];

const seenPosts = new Set();
const seenFollowControls = new WeakSet();

let detectedPosts = [];
let trackedFollows = [];

const followContext = new Map();
const FOLLOW_CONTEXT_TTL = 8000;

function normalizeUsername(value) {
  return XFIStorage.normalizeUsername(value);
}

function extractUsernameFromLink(link) {
  if (!link) return "";
  try {
    const url = new URL(link.href, location.origin);
    const parts = url.pathname.split("/").filter(Boolean);
    if (!parts.length) return "";
    if (parts[0] === "i") return "";
    if (parts[1] === "status") return normalizeUsername(parts[0]);
    return normalizeUsername(parts[0]);
  } catch {
    return "";
  }
}

function getAuthorFromArticle(article) {
  const statusLink = article.querySelector('a[href*="/status/"]');
  return extractUsernameFromLink(statusLink);
}

function getPostUrlFromArticle(article) {
  const statusLink = article.querySelector('a[href*="/status/"]');
  return statusLink ? XFIStorage.normalizePostUrl(statusLink.href) : "";
}

function getPostText(article) {
  const node = article.querySelector('[data-testid="tweetText"]');
  return node?.innerText?.trim() || "";
}

function isNetworkingText(text) {
  const normalized = text.toLowerCase();
  return connectKeywords.some((keyword) => normalized.includes(keyword));
}

function findDetectedPost(author) {
  const normalized = normalizeUsername(author);
  return detectedPosts.find((post) => post.author === normalized) || null;
}

function armFollowContext(author, post) {
  if (!author || !post) return;

  followContext.set(author, {
    author,
    post,
    expiresAt: Date.now() + FOLLOW_CONTEXT_TTL
  });
}

function cleanupExpiredContexts() {
  const now = Date.now();
  for (const [author, context] of followContext) {
    if (context.expiresAt <= now) followContext.delete(author);
  }
}

function scanPosts() {
  const articles = document.querySelectorAll("article");

  articles.forEach((article) => {
    const url = getPostUrlFromArticle(article);
    if (!url) return;

    const postId = XFIStorage.makePostId(url);
    if (seenPosts.has(postId)) return;

    const author = getAuthorFromArticle(article);
    const text = getPostText(article);

    // Do not mark a post seen until its text/author are available.
    if (!author || !text) return;

    seenPosts.add(postId);

    if (!isNetworkingText(text)) return;

    const post = {
      postId,
      author,
      text,
      url,
      createdAt: new Date().toISOString()
    };

    detectedPosts = [
      post,
      ...detectedPosts.filter((item) => item.postId !== postId)
    ];
    chrome.runtime.sendMessage({
      type: "DETECTED_POST",
      post
    }, () => {
      void chrome.runtime.lastError;
    });
  });
}

function getFollowCandidate(element) {
  if (!element) return "";

  const aria = element.getAttribute?.("aria-label") || "";
  const dataTest = element.getAttribute?.("data-testid") || "";
  const text = (element.innerText || element.textContent || "").trim();

  const values = [aria, text, dataTest];

  for (const value of values) {
    const match = value.match(/^Follow(?:\s+@?([A-Za-z0-9_]+))?$/i);
    if (match?.[1]) return normalizeUsername(match[1]);
  }

  if (/^follow$/i.test(aria) || /^follow$/i.test(text)) {
    const link = element.closest("div")?.querySelector('a[href^="/"][href*="/status/"], a[href^="/"]:not([href*="/status/"])');
    const fromLink = extractUsernameFromLink(link);
    if (fromLink) return fromLink;
  }

  return "";
}

function getFollowContextForElement(element, username) {
  const article = element.closest("article");

  if (article) {
    const url = getPostUrlFromArticle(article);
    const author = getAuthorFromArticle(article);
    if (url && author === username) {
      const post = detectedPosts.find((item) => item.url === url);
      if (post) {
        return { post, source: "direct" };
      }
    }
  }

  cleanupExpiredContexts();

  const armed = followContext.get(username);
  if (armed && armed.expiresAt > Date.now()) {
    return { post: armed.post, source: "armed_context" };
  }

  // Compatibility fallback with V1 behavior.
  // This preserves working tracking when X detaches the Follow control
  // from the post DOM and no stronger context is available.
  const fallback = findDetectedPost(username);
  if (fallback) {
    return { post: fallback, source: "author_fallback" };
  }

  return null;
}

function trackFollow(username, context) {
  const follow = XFIStorage.normalizeFollow({
    followId: XFIStorage.makeId("follow"),
    postId: context.post.postId,
    author: username,
    followedAt: new Date().toISOString(),
    checkedAt: null,
    checkAttempts: 0,
    status: "WAITING",
    lastCheckResult: null,
    errorReason: null,
    post: context.post
  });

  if (!follow) return;

  const alreadyTracked = trackedFollows.some(
    (item) =>
      item.author === username &&
      ["WAITING", "CHECKING", "RETRY_PENDING"].includes(item.status)
  );

  if (alreadyTracked) {
    return;
  }

  trackedFollows.push(follow);
  chrome.runtime.sendMessage({
    type: "FOLLOW_TRACKED",
    follow
  }, (response) => {
    if (chrome.runtime.lastError || !response?.ok) {
      return;
    }
  });
}

function scanFollowControls() {
  const candidates = document.querySelectorAll(
    'button, [role="button"], [role="menuitem"], [data-testid]'
  );

  candidates.forEach((element) => {
    if (seenFollowControls.has(element)) return;

    const username = getFollowCandidate(element);
    if (!username) return;

    seenFollowControls.add(element);

    element.addEventListener("click", () => {
      const context = getFollowContextForElement(element, username);

      if (!context) {
        console.log("[XFI] Follow detected but no reliable networking-post context; ignored.", {
          username
        });
        return;
      }

      trackFollow(username, context);
    }, { capture: true });
  });
}

// Capture clicks globally as a second path for detached/portal-based X controls.
document.addEventListener("click", (event) => {
  const target = event.target instanceof Element
    ? event.target.closest('button, [role="button"], [role="menuitem"], [data-testid]')
    : null;

  if (!target) return;

  const username = getFollowCandidate(target);
  if (!username) return;

  const context = getFollowContextForElement(target, username);
  if (!context) {
    console.log("[XFI] Follow detected but no reliable networking-post context; ignored.", {
      username
    });
    return;
  }

  trackFollow(username, context);
}, true);

document.addEventListener("pointerover", (event) => {
  const target = event.target instanceof Element
    ? event.target.closest("a[href]")
    : null;

  if (!target) return;

  const username = extractUsernameFromLink(target);
  if (!username) return;

  const article = target.closest("article");
  if (!article) return;

  const url = getPostUrlFromArticle(article);
  const author = getAuthorFromArticle(article);

  if (!url || author !== username) return;

  const post = detectedPosts.find((item) => item.url === url);
  if (post) armFollowContext(username, post);
}, true);

function followsMe() {
  const indicators = [...document.querySelectorAll(
    '[data-testid="userFollowIndicator"]'
  )];

  const indicator = indicators.find((node) =>
    /follows you/i.test((node.innerText || node.textContent || "").trim())
  );

  if (indicator) {
    return "FOLLOWED_BACK";
  }

  // A profile page with a visible follow button means the target isn't
  // currently following us. Only treat it as negative when the profile
  // UI has actually rendered.
  const buttons = [...document.querySelectorAll('button, [role="button"]')];
  const hasFollowButton = buttons.some((node) => {
    const label = `${node.getAttribute("aria-label") || ""} ${node.innerText || ""}`;
    return /^follow\b/i.test(label.trim());
  });

  if (hasFollowButton) {
    return "NOT_FOLLOWED_BACK";
  }

  return "UNKNOWN";
}

function waitForFollowResult(timeout = 7000) {
  return new Promise((resolve) => {
    const result = followsMe();
    if (result !== "UNKNOWN") {
      resolve(result);
      return;
    }

    const observer = new MutationObserver(() => {
      const next = followsMe();
      if (next !== "UNKNOWN") {
        observer.disconnect();
        resolve(next);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true
    });

    setTimeout(() => {
      observer.disconnect();
      resolve("UNKNOWN");
    }, timeout);
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "CHECK_FOLLOW_BACK") return;

  waitForFollowResult().then((result) => {
    if (result === "FOLLOWED_BACK") {
      sendResponse({
        result: "FOLLOWED_BACK"
      });
      return;
    }

    if (result === "NOT_FOLLOWED_BACK") {
      sendResponse({
        result: "NOT_FOLLOWED_BACK"
      });
      return;
    }

    sendResponse({
      result: "UNKNOWN",
      errorReason: "FOLLOW_BACK_UI_NOT_DETERMINED"
    });
  });

  return true;
});

const postObserver = new MutationObserver(() => {
  scanPosts();
  scanFollowControls();
});

const followObserver = new MutationObserver(() => {
  scanFollowControls();
});

function startObservers() {
  if (!document.body) return;

  postObserver.observe(document.body, {
    childList: true,
    subtree: true
  });

  followObserver.observe(document.body, {
    childList: true,
    subtree: true
  });

  scanPosts();
  scanFollowControls();

  setInterval(cleanupExpiredContexts, 2000);
}

chrome.storage.local.get(
  ["detectedPosts", "trackedFollows"],
  (result) => {
    detectedPosts = Array.isArray(result.detectedPosts)
      ? result.detectedPosts.map(XFIStorage.normalizePost).filter(Boolean)
      : [];

    trackedFollows = Array.isArray(result.trackedFollows)
      ? result.trackedFollows.map(XFIStorage.normalizeFollow).filter(Boolean)
      : [];

    detectedPosts.forEach((post) => seenPosts.add(post.postId));

    startObservers();
  }
);
