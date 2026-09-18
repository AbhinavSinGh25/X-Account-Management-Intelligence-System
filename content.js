console.log("🚀 X Follow Intelligence is running!");
console.log("🔑 EXTENSION ID:", chrome.runtime.id);


// ========================================
// STORAGE
// ========================================

const seenPosts = new Set();

let detectedPosts = [];
let trackedFollows = [];


// ========================================
// NETWORKING KEYWORDS
// ========================================

const connectKeywords = [
  "let's connect",
  "lets connect",
  "looking to connect",
  "connect with",
  "grow together",
  "networking",
];


// ========================================
// LOAD SAVED DATA
// ========================================

chrome.storage.local.get(
  ["detectedPosts", "trackedFollows"],
  (result) => {

    if (result.detectedPosts) {
      detectedPosts = result.detectedPosts;

      console.log(
        "📦 Loaded saved posts:",
        detectedPosts.length
      );

      detectedPosts.forEach((post) => {
        seenPosts.add(post.url);
      });
    }

    if (result.trackedFollows) {
      trackedFollows = result.trackedFollows;

      console.log(
        "📦 Loaded tracked follows:",
        trackedFollows.length
      );
    }

    // Start observing the X page
    postObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });

    followObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });

    // Initial scan
    scanPosts();
    scanFollowButtons();
  }
);


// ========================================
// POST DETECTION
// ========================================

function scanPosts() {

  const posts = document.querySelectorAll("article");

  posts.forEach((post) => {

    const links = post.querySelectorAll(
      'a[href*="/status/"]'
    );

    if (links.length === 0) return;

    const postLink = links[0].href;

    const author = postLink.split("/")[3];

    if (seenPosts.has(postLink)) return;

    seenPosts.add(postLink);

    const tweetTextElement = post.querySelector(
      '[data-testid="tweetText"]'
    );

    const tweetText = tweetTextElement
      ? tweetTextElement.innerText
      : "No text found";

    const postData = {
      author: author,
      text: tweetText,
      url: postLink,
    };

    console.log("🆕 NEW POST DETECTED");
    console.log(postData);

    const text = tweetText.toLowerCase();

    const isConnectPost =
      connectKeywords.some((keyword) =>
        text.includes(keyword)
      );

    if (!isConnectPost) return;

    detectedPosts.push(postData);

    chrome.storage.local.set({
      detectedPosts: detectedPosts,
    });

    console.log(
      "🤝 POTENTIAL CONNECT POST DETECTED!"
    );

    console.log(
      "Total detected:",
      detectedPosts.length
    );

    console.log(postData);
  });
}


// ========================================
// POST OBSERVER
// ========================================

const postObserver = new MutationObserver(() => {
  scanPosts();
});


// ========================================
// FOLLOW-BACK CHECK
// ========================================

function followsMe() {

  const indicator = document.querySelector(
    '[data-testid="userFollowIndicator"]'
  );

  if (!indicator) {
    return false;
  }

  return (
    indicator.innerText.trim() === "Follows you"
  );
}


// Wait until X renders the follow indicator
function waitForFollowIndicator(
  timeout = 5000
) {

  return new Promise((resolve) => {

    const existingIndicator =
      document.querySelector(
        '[data-testid="userFollowIndicator"]'
      );

    if (existingIndicator) {
      resolve(existingIndicator);
      return;
    }

    const observer = new MutationObserver(() => {

      const indicator =
        document.querySelector(
          '[data-testid="userFollowIndicator"]'
        );

      if (indicator) {

        observer.disconnect();

        resolve(indicator);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    setTimeout(() => {

      observer.disconnect();

      resolve(null);

    }, timeout);
  });
}


// ========================================
// MESSAGE FROM BACKGROUND
// ========================================

chrome.runtime.onMessage.addListener(
  (message, sender, sendResponse) => {

    console.log("📩 MESSAGE:", message);

    if (
      message.type !== "CHECK_FOLLOW_BACK"
    ) {
      return;
    }

    console.log(
      "🔍 CHECKING USER:",
      message.author
    );

    waitForFollowIndicator().then(
      (indicator) => {

        console.log(
          "🔎 INDICATOR:",
          indicator
        );

        const followedBack =
          followsMe();

        console.log(
          "🤝 FOLLOWED BACK:",
          followedBack
        );

        sendResponse({
          author: message.author,
          followedBack: followedBack,
        });
      }
    );

    // Keep message channel open
    return true;
  }
);


// ========================================
// FOLLOW BUTTON DETECTION
// ========================================

const followObserver =
  new MutationObserver(() => {

    scanFollowButtons();

  });


function scanFollowButtons() {

  const menuItems =
    document.querySelectorAll(
      '[role="menuitem"]'
    );

  menuItems.forEach((item) => {

    const text =
      item.innerText.trim();

    if (!text.startsWith("Follow @")) {
      return;
    }

    const username =
      text.replace("Follow @", "");

    console.log(
      "🟡 NOT FOLLOWING:",
      username
    );

    if (
      item.dataset.followListenerAttached
    ) {
      return;
    }

    item.dataset.followListenerAttached =
      "true";

    item.addEventListener(
      "click",
      () => {

        console.log(
          "🎯 FOLLOW CLICKED:",
          username
        );

        const matchedPost =
          detectedPosts.find(
            (post) =>
              post.author === username
          );

        console.log(
          "🔎 MATCHED POST:",
          matchedPost
        );

        if (!matchedPost) {

          console.log(
            "⚠️ FOLLOW NOT TRACKED — NO MATCHING NETWORKING POST"
          );

          return;
        }

        console.log(
          "🤝 NETWORKING FOLLOW CONFIRMED!"
        );

        const alreadyTracked =
          trackedFollows.some(
            (follow) =>
              follow.author === username &&
              follow.status === "WAITING"
          );

        if (alreadyTracked) {

          console.log(
            "⚠️ USER ALREADY BEING TRACKED"
          );

          return;
        }

        const followData = {

          author: username,

          followedAt:
            new Date().toISOString(),

          post: matchedPost,

          followedBack: undefined,

          status: "WAITING",
        };

        trackedFollows.push(
          followData
        );

        chrome.storage.local.set(
          {
            trackedFollows:
              trackedFollows,
          },
          () => {

            console.log(
              "📌 FOLLOW TRACKED:",
              followData
            );

            chrome.runtime.sendMessage({
              type: "FOLLOW_TRACKED",
              author: username,
            });
          }
        );
      }
    );
  });
}