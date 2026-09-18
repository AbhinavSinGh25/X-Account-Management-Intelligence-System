const followsContainer = document.getElementById("follows");

const statusLabels = {
  WAITING: "Waiting for follow-back check",
  CHECKING: "Checking follow-back status",
  FOLLOWED_BACK: "Followed back",
  NOT_FOLLOWED_BACK: "Not followed back",
  CHECK_FAILED: "Check failed",
  RETRY_PENDING: "Check could not be confirmed; retry pending",
};

function statusClass(status) {
  return status === "FOLLOWED_BACK" ? "followed" : status === "NOT_FOLLOWED_BACK" ? "negative" : "consider";
}

function appendText(parent, tag, value) {
  const element = document.createElement(tag);
  element.textContent = value;
  parent.appendChild(element);
  return element;
}

function renderEmptyState() {
  const empty = document.createElement("p");
  empty.className = "empty";
  empty.textContent = "No tracked follows yet.";
  followsContainer.appendChild(empty);
}

function renderFollow(follow, postsById) {
  const card = document.createElement("div");
  card.className = "card";
  appendText(card, "strong", `@${follow.author}`);

  const status = document.createElement("p");
  status.className = statusClass(follow.status);
  const dot = document.createElement("span");
  dot.className = "status-dot";
  status.append(dot, document.createTextNode(statusLabels[follow.status] || "Unknown status"));
  card.appendChild(status);

  const followedAt = follow.followedAt ? new Date(follow.followedAt) : null;
  appendText(card, "small", `Followed: ${followedAt && !Number.isNaN(followedAt) ? followedAt.toLocaleString() : "Unknown"}`);
  if (follow.checkedAt) appendText(card, "small", `Checked: ${new Date(follow.checkedAt).toLocaleString()}`);
  if (follow.errorReason) appendText(card, "small", `Check note: ${follow.errorReason}`);

  const post = postsById.get(follow.postId);
  if (post && safePostUrl(post.url)) {
    card.appendChild(document.createElement("br"));
    const link = document.createElement("a");
    link.href = post.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "View Post";
    card.appendChild(link);
  }
  followsContainer.appendChild(card);
}

chrome.storage.local.get(["detectedPosts", "trackedFollows"], (result) => {
  const follows = Array.isArray(result.trackedFollows) ? result.trackedFollows : [];
  const posts = Array.isArray(result.detectedPosts) ? result.detectedPosts : [];
  if (!follows.length) return renderEmptyState();
  const postsById = new Map(posts.map((post) => [post.postId, post]));
  follows.slice().sort((a, b) => Date.parse(b.followedAt) - Date.parse(a.followedAt)).forEach((follow) => renderFollow(follow, postsById));
});

