console.log("⚙️ Background worker is running!");

const checkTabs = new Map();

chrome.runtime.onMessage.addListener((message) => {
  console.log("📩 MESSAGE RECEIVED:", message);

  if (message.type === "FOLLOW_TRACKED") {
    const alarmName = `check_${message.author}`;

    chrome.alarms.create(alarmName, {
      delayInMinutes: 0.5,
    });

    console.log("⏰ ALARM CREATED:", alarmName);
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  console.log("🔔 ALARM FIRED:", alarm.name);

  const username = alarm.name.replace("check_", "");

  console.log("👤 USER TO CHECK:", username);

chrome.tabs.create(
  {
    url: `https://x.com/${username}`,
    active: false,
  },
  (tab) => {
    checkTabs.set(tab.id, username);

    console.log("🌐 CHECK TAB CREATED:", tab.id);

    // In case the page already finished loading
    chrome.tabs.get(tab.id, (currentTab) => {
      if (chrome.runtime.lastError) return;

      if (currentTab.status === "complete") {
        checkProfile(tab.id);
      }
    });
  }
);
});


function checkProfile(tabId) {
  if (!checkTabs.has(tabId)) return;

  const username = checkTabs.get(tabId);

  console.log("🌐 PROFILE LOADED:", username);

  chrome.tabs.sendMessage(
    tabId,
    {
      type: "CHECK_FOLLOW_BACK",
      author: username,
    },
    (response) => {
      if (chrome.runtime.lastError) {
        console.log(
          "❌ MESSAGE ERROR:",
          chrome.runtime.lastError.message
        );
        return;
      }

      console.log("📨 CHECK RESULT:", response);

      if (!response) return;

      chrome.storage.local.get("trackedFollows", (result) => {
        const trackedFollows =
          result.trackedFollows || [];

        const trackedFollow =
          trackedFollows.find(
            (follow) =>
              follow.author === response.author
          );

        if (!trackedFollow) return;

        trackedFollow.followedBack =
          response.followedBack;

        trackedFollow.status =
          response.followedBack
            ? "FOLLOWED_BACK"
            : "CONSIDER_UNFOLLOWING";

        chrome.storage.local.set(
          {
            trackedFollows: trackedFollows,
          },
          () => {
            console.log(
              "💾 FINAL STATUS SAVED:",
              trackedFollow
            );

            chrome.tabs.remove(tabId);

            checkTabs.delete(tabId);
          }
        );
      });
    }
  );
}

chrome.tabs.onUpdated.addListener(
  (tabId, changeInfo) => {

    if (!checkTabs.has(tabId)) return;

    if (changeInfo.status !== "complete") return;

    checkProfile(tabId);
  }
);