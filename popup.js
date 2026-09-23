const followsContainer = document.getElementById("follows");
const totalElement = document.getElementById("total");

function statusLabel(follow) {
  switch (follow.status) {
    case "WAITING":
      return "Waiting for follow-back check";
    case "CHECKING":
      return "Checking follow-back";
    case "FOLLOWED_BACK":
      return "Followed back";
    case "NOT_FOLLOWED_BACK":
      return "Not followed back";
    case "RETRY_PENDING":
      return "Retry pending";
    case "UNFOLLOWED":
      return "Unfollowed";
    case "CHECK_FAILED":
      return "Check failed";
    default:
      return "Unknown";
  }
}

function statusClass(status) {
  if (status === "FOLLOWED_BACK") return "followed";
  if (status === "UNFOLLOWED") return "unfollowed";
  if (["CHECK_FAILED", "NOT_FOLLOWED_BACK"].includes(status)) return "negative";
  return "waiting";
}

function createCard(follow) {
  const card = document.createElement("div");
  card.className = "card";

  const author = document.createElement("strong");
  author.textContent = `@${follow.author}`;

  const status = document.createElement("p");
  status.className = statusClass(follow.status);

  const dot = document.createElement("span");
  dot.className = "status-dot";

  status.append(dot, document.createTextNode(statusLabel(follow)));

  const time = document.createElement("small");
  const date = new Date(follow.followedAt);
  time.textContent = `Followed: ${Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString()}`;

  card.append(author, status, time);

  if (follow.post?.url && XFIStorage.normalizePostUrl(follow.post.url)) {
    card.appendChild(document.createElement("br"));
    card.appendChild(document.createElement("br"));

    const link = document.createElement("a");
    link.href = XFIStorage.normalizePostUrl(follow.post.url);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "View Post →";
    card.appendChild(link);
  }

  if (follow.errorReason) {
    const reason = document.createElement("small");
    reason.textContent = `Reason: ${follow.errorReason}`;
    card.appendChild(reason);
  }

  return card;
}

chrome.storage.local.get("trackedFollows", (result) => {
  const follows = Array.isArray(result.trackedFollows)
    ? result.trackedFollows.map(XFIStorage.normalizeFollow).filter(Boolean)
    : [];

  totalElement.textContent = String(follows.length);

  follows
    .sort((a, b) => Date.parse(b.followedAt) - Date.parse(a.followedAt))
    .forEach((follow) => followsContainer.appendChild(createCard(follow)));

  if (!follows.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No networking follows tracked yet.";
    followsContainer.appendChild(empty);
  }
});
