const connectKeywords = [
  "let's connect",
  "lets connect",
  "looking to connect",
  "connect with me",
  "connect with us",
  "connect with you",
  "feel free to connect",
  "happy to connect",
  "would love to connect",
  "open to connecting",
  "open to connect",
  "let's network",
  "lets network",
  "network with",
  "networking",
  "grow together",
];

const networkingContextWords = [
  "founder",
  "founders",
  "developer",
  "developers",
  "engineer",
  "engineers",
  "designer",
  "designers",
  "professional",
  "professionals",
  "recruiter",
  "recruiters",
  "career",
  "careers",
  "job",
  "jobs",
  "hiring",
  "startup",
  "startups",
  "entrepreneur",
  "entrepreneurs",
  "tech",
  "technology",
  "community",
  "communities",
  "network",
  "networking",
  "opportunity",
  "opportunities",
  "collaborate",
  "collaboration",
  "dm",
  "reach out",
];

const seenPosts = new Set();
const seenFollowControls = new WeakSet();

let detectedPosts = [];
let trackedFollows = [];

const followContext = new Map();
const FOLLOW_CONTEXT_TTL = 8000;
let lastFollowingContext = null;

function normalizeUsername(value) {
  return XFIStorage.normalizeUsername(value);
}

function extractUsernameFromLink(link) {
  if (!link) return "";
  try {
    const url = new URL(link.href, location.origin);
    const parts = url.pathname.split("/").filter(Boolean);
    if (!parts.length || parts[0] === "i") return "";
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
  const normalized = String(text || "")
    .toLowerCase()
    .replaceAll("#", "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return false;

  const hasDirectSignal = connectKeywords.some((keyword) =>
    normalized.includes(keyword)
  );

  if (hasDirectSignal) return true;

  const hasNetworkWord = /\b(connect|connecting|network|networking)\b/i.test(
    normalized
  );
  const hasProfessionalContext = networkingContextWords.some((word) =>
    normalized.includes(word)
  );

  return hasNetworkWord && hasProfessionalContext;
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
    expiresAt: Date.now() + FOLLOW_CONTEXT_TTL,
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

    const author = getAuthorFromArticle(article);
    const text = getPostText(article);
    if (!author || !text) return;

    // X can render the article before the tweet text is complete.
    // Only mark it seen after we have classified the current text.
    if (seenPosts.has(postId)) return;
    if (!isNetworkingText(text)) return;

    seenPosts.add(postId);

    const post = {
      postId,
      author,
      text,
      url,
      createdAt: new Date().toISOString(),
    };

    detectedPosts = [
      post,
      ...detectedPosts.filter((item) => item.postId !== postId),
    ];

    chrome.runtime.sendMessage({ type: "DETECTED_POST", post }, () => {
      void chrome.runtime.lastError;
    });
  });
}

function getFollowCandidate(element) {
  if (!element) return "";

  const text = (element.innerText || element.textContent || "").trim();
  const aria = element.getAttribute?.("aria-label") || "";
  const dataTest = element.getAttribute?.("data-testid") || "";

  // Prefer visible text because X can expose stale/generated aria labels.
  const values = [text, aria, dataTest];

  for (const value of values) {
    const match = value.match(/^Follow(?:\s+@?([A-Za-z0-9_]+))?$/i);
    if (match?.[1]) return normalizeUsername(match[1]);
  }

  if (/^follow$/i.test(text) || /^follow$/i.test(aria)) {
    const link = element
      .closest("div")
      ?.querySelector(
        'a[href^="/"][href*="/status/"], a[href^="/"]:not([href*="/status/"])',
      );
    const fromLink = extractUsernameFromLink(link);
    if (fromLink) return fromLink;
  }

  return "";
}

function getUnfollowCandidate(element) {
  if (!element) return "";

  const text = (element.innerText || element.textContent || "").trim();
  const aria = element.getAttribute?.("aria-label") || "";
  const dataTest = element.getAttribute?.("data-testid") || "";

  const values = [text, aria, dataTest];

  for (const value of values) {
    const match = value.match(/^Unfollow(?:\s+@?([A-Za-z0-9_]+))?/i);

    if (match?.[1]) {
      return normalizeUsername(match[1]);
    }
  }

  if (
    values.some((value) =>
      /^unfollow(?:\s|$)/i.test(value.trim())
    )
  ) {
    return getUsernameNearElement(element);
  }

  return "";
}

function getUsernameNearElement(element) {
  if (
    lastFollowingContext &&
    lastFollowingContext.expiresAt > Date.now()
  ) {
    return lastFollowingContext.username;
  }

  const article = element.closest("article");
  if (article) {
    const author = getAuthorFromArticle(article);
    if (author) return author;
  }

  const href = element
    .closest("div")
    ?.querySelector('a[href^="/"]:not([href^="/i/"])');

  const linkedUsername = extractUsernameFromLink(href);
  if (linkedUsername) return linkedUsername;

  try {
    const parts = location.pathname.split("/").filter(Boolean);
    if (parts.length === 1 && parts[0] !== "home") {
      return normalizeUsername(parts[0]);
    }
  } catch {
    // Ignore malformed/non-profile URLs.
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
      if (post) return { post, source: "direct" };
    }
  }

  cleanupExpiredContexts();

  const armed = followContext.get(username);
  if (armed && armed.expiresAt > Date.now()) {
    return { post: armed.post, source: "armed_context" };
  }

  const fallback = findDetectedPost(username);
  if (fallback) return { post: fallback, source: "author_fallback" };

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
    post: context.post,
  });

  if (!follow) return;

  const alreadyTracked = trackedFollows.some(
    (item) =>
      item.author === username &&
      ["WAITING", "CHECKING", "RETRY_PENDING"].includes(item.status),
  );

  if (alreadyTracked) return;

  trackedFollows.push(follow);
  chrome.runtime.sendMessage({ type: "FOLLOW_TRACKED", follow }, () => {
    void chrome.runtime.lastError;
  });
}

function rememberFollowingContext(element) {
  const text = (element?.innerText || element?.textContent || "").trim();
  const aria = element?.getAttribute?.("aria-label") || "";
  const values = [text, aria];

  for (const value of values) {
    const match = value.match(/^Following(?:\s+@?([A-Za-z0-9_]+))?/i);
    if (match?.[1]) {
      lastFollowingContext = {
        username: normalizeUsername(match[1]),
        expiresAt: Date.now() + FOLLOW_CONTEXT_TTL,
      };
      return;
    }
  }

  const username = getUsernameNearElement(element);
  if (username) {
    lastFollowingContext = {
      username,
      expiresAt: Date.now() + FOLLOW_CONTEXT_TTL,
    };
  }
}

function scanFollowControls() {
  const candidates = document.querySelectorAll(
    'button, [role="button"], [role="menuitem"], [data-testid]',
  );

  candidates.forEach((element) => {
    if (seenFollowControls.has(element)) return;

    const username = getFollowCandidate(element);
    if (!username) return;

    seenFollowControls.add(element);

    element.addEventListener(
      "click",
      () => {
        const context = getFollowContextForElement(element, username);
        if (!context) {
          console.log(
            "[XFI] Follow detected but no reliable networking-post context; ignored.",
            { username },
          );
          return;
        }
        trackFollow(username, context);
      },
      { capture: true },
    );
  });
}

document.addEventListener(
  "click",
  (event) => {
    const target =
      event.target instanceof Element
        ? event.target.closest(
            'button, [role="button"], [role="menuitem"], [data-testid]',
          )
        : null;
    if (!target) return;

    const unfollowUsername = getUnfollowCandidate(target);
    if (unfollowUsername) {
      chrome.runtime.sendMessage(
        { type: "FOLLOW_UNFOLLOWED", username: unfollowUsername },
        () => {
          void chrome.runtime.lastError;
        },
      );
      return;
    }

    const followingText =
      `${target.innerText || ""} ${target.getAttribute("aria-label") || ""}`.trim();
    if (/^following(?:\s|$)/i.test(followingText)) {
      rememberFollowingContext(target);
    }
  },
  true,
);

document.addEventListener(
  "click",
  (event) => {
    const target =
      event.target instanceof Element
        ? event.target.closest(
            'button, [role="button"], [role="menuitem"], [data-testid]',
          )
        : null;
    if (!target) return;

    const username = getFollowCandidate(target);
    if (!username) return;

    const context = getFollowContextForElement(target, username);
    if (!context) {
      console.log(
        "[XFI] Follow detected but no reliable networking-post context; ignored.",
        { username },
      );
      return;
    }

    trackFollow(username, context);
  },
  true,
);

document.addEventListener(
  "pointerover",
  (event) => {
    const target =
      event.target instanceof Element ? event.target.closest("a[href]") : null;
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
  },
  true,
);

function hasVisibleText(pattern) {
  return [...document.querySelectorAll("span, div")].some((node) => {
    if (!(node instanceof HTMLElement)) return false;
    const text = (node.innerText || node.textContent || "").trim();
    if (!text || text.length > 80 || !pattern.test(text)) return false;
    const style = window.getComputedStyle(node);
    return style.display !== "none" && style.visibility !== "hidden";
  });
}

function followsMe() {
  const pageText = document.body?.innerText || "";

  // Positive proof: the target explicitly follows us.
  if (/follows you/i.test(pageText)) {
    return "FOLLOWED_BACK";
  }

  const controls = [
    ...document.querySelectorAll(
      'button, [role="button"], [data-testid]'
    )
  ];

  const hasFollowingControl = controls.some((node) => {
    if (!(node instanceof HTMLElement)) return false;

    const values = [
      node.getAttribute("aria-label") || "",
      node.innerText || "",
      node.textContent || ""
    ]
      .map((value) => value.trim())
      .filter(Boolean);

    return values.some((value) =>
      /^following(?:\s|$)/i.test(value)
    );
  });

  if (hasFollowingControl) {
    return "NOT_FOLLOWED_BACK";
  }

  return "UNKNOWN";
}


function waitForFollowResult(timeout = 10000) {
  return new Promise((resolve) => {
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearTimeout(timeoutTimer);
      clearTimeout(initialDelayTimer);
      resolve(result);
    };

    const observer = new MutationObserver(() => {
      const result = followsMe();

      if (result !== "UNKNOWN") {
        finish(result);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
    });

    // Give X time to hydrate/render the profile UI.
    const initialDelayTimer = setTimeout(() => {
      const result = followsMe();

      if (result !== "UNKNOWN") {
        finish(result);
      }
    }, 2500);

    const timeoutTimer = setTimeout(() => {
      finish("UNKNOWN");
    }, timeout);
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "CHECK_FOLLOW_BACK") return;

  waitForFollowResult().then((result) => {
    let response;

    if (result === "FOLLOWED_BACK") {
      response = { result: "FOLLOWED_BACK" };
    } else if (result === "NOT_FOLLOWED_BACK") {
      response = { result: "NOT_FOLLOWED_BACK" };
    } else {
      response = {
        result: "UNKNOWN",
        errorReason: "FOLLOW_BACK_UI_NOT_DETERMINED",
      };
    }

    sendResponse(response);
  });

  return true;
});

const postObserver = new MutationObserver(() => {
  scanPosts();
  scanFollowControls();
});

const followObserver = new MutationObserver(() => scanFollowControls());

function startObservers() {
  if (!document.body) return;

  postObserver.observe(document.body, { childList: true, subtree: true });
  followObserver.observe(document.body, { childList: true, subtree: true });
  scanPosts();
  scanFollowControls();
  setInterval(cleanupExpiredContexts, 2000);
}

chrome.storage.local.get(["detectedPosts", "trackedFollows"], (result) => {
  detectedPosts = Array.isArray(result.detectedPosts)
    ? result.detectedPosts.map(XFIStorage.normalizePost).filter(Boolean)
    : [];

  trackedFollows = Array.isArray(result.trackedFollows)
    ? result.trackedFollows.map(XFIStorage.normalizeFollow).filter(Boolean)
    : [];

  detectedPosts.forEach((post) => seenPosts.add(post.postId));
  startObservers();
});
