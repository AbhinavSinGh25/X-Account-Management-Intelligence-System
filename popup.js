console.log("📊 Popup is running!");

const followsContainer = document.getElementById("follows");

chrome.storage.local.get("trackedFollows", (result) => {
  console.log("💾 TRACKED FOLLOWS:", result.trackedFollows);

  result.trackedFollows.forEach((follow) => {
    const card = document.createElement("div");
    card.className = "card";
    const followedTime = new Date(
      follow.followedAt || follow.time,
    ).toLocaleString();

    card.innerHTML = `
  <strong>${follow.author}</strong>

  <p class="${follow.followedBack ? "followed" : "consider"}">
    <span class="status-dot"></span>
    ${
      follow.status === "WAITING"
        ? "Waiting for follow-back check"
        : follow.followedBack
          ? "Followed back"
          : "Consider unfollowing"
    }
  </p>

  <small>Followed: ${followedTime}</small>

  <br><br>

  <a href="${follow.post.url}" target="_blank">View Post</a>
`;
    followsContainer.appendChild(card);
  });
});
