const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const pool = require("./db");

const app = express();

app.use(express.json());

app.get("/api/health", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");

    res.json({
      status: "ok",
      database: "connected",
      time: result.rows[0].now,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      status: "error",
      database: "disconnected",
    });
  }
});

app.post("/api/users", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: "Email and password are required",
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users (id, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, email, created_at`,
      [crypto.randomUUID(), email, passwordHash]
    );

    res.status(201).json({
      user: result.rows[0],
    });
  } catch (error) {
    console.error(error);

    if (error.code === "23505") {
      return res.status(409).json({
        error: "Email already exists",
      });
    }

    res.status(500).json({
      error: "Failed to create user",
    });
  }
});

app.post("/api/posts", async (req, res) => {
  try {
    const {
      user_id,
      x_post_id,
      author_x_user_id,
      author_username,
      post_url,
      post_text,
    } = req.body;

    if (
      !user_id ||
      !x_post_id ||
      !author_x_user_id ||
      !author_username ||
      !post_url ||
      !post_text
    ) {
      return res.status(400).json({
        error: "All post fields are required",
      });
    }

    const result = await pool.query(
      `INSERT INTO networking_posts
       (id, user_id, x_post_id, author_x_user_id, author_username, post_url, post_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, x_post_id)
       DO UPDATE SET
         author_x_user_id = EXCLUDED.author_x_user_id,
         author_username = EXCLUDED.author_username,
         post_url = EXCLUDED.post_url,
         post_text = EXCLUDED.post_text
       RETURNING *`,
      [
        crypto.randomUUID(),
        user_id,
        x_post_id,
        author_x_user_id,
        author_username,
        post_url,
        post_text,
      ]
    );

    res.status(201).json({
      post: result.rows[0],
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Failed to create networking post",
    });
  }
});

app.get("/api/posts/by-x-id/:xPostId", async (req, res) => {
  try {
    const { xPostId } = req.params;
    const { user_id } = req.query;

    if (!xPostId || !user_id) {
      return res.status(400).json({
        error: "xPostId and user_id are required",
      });
    }

    const result = await pool.query(
      `SELECT *
       FROM networking_posts
       WHERE x_post_id = $1
         AND user_id = $2
       LIMIT 1`,
      [xPostId, user_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Networking post not found",
      });
    }

    res.json({
      post: result.rows[0],
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Failed to find networking post",
    });
  }
});

app.get("/api/follows/by-x-user-id/:xUserId", async (req, res) => {
  try {
    const { xUserId } = req.params;
    const { user_id } = req.query;

    if (!xUserId || !user_id) {
      return res.status(400).json({
        error: "xUserId and user_id are required",
      });
    }

    const result = await pool.query(
      `SELECT *
       FROM follows
       WHERE x_user_id = $1
         AND user_id = $2
       LIMIT 1`,
      [xUserId, user_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Follow not found",
      });
    }

    res.json({ follow: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to find follow" });
  }
});

app.post("/api/follows", async (req, res) => {
  try {
    const {
      user_id,
      x_user_id,
      username,
      source_post_id,
    } = req.body;

    if (!user_id || !x_user_id || !username || !source_post_id) {
      return res.status(400).json({
        error: "All follow fields are required",
      });
    }

    const result = await pool.query(
      `INSERT INTO follows
       (id, user_id, x_user_id, username, source_post_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        crypto.randomUUID(),
        user_id,
        x_user_id,
        username,
        source_post_id,
      ]
    );

    const follow = result.rows[0];

    await pool.query(
      `INSERT INTO relationship_events
       (id, user_id, x_user_id, event_type, source_post_id, metadata)
       VALUES ($1, $2, $3, 'FOLLOWED', $4, $5)`,
      [
        crypto.randomUUID(),
        follow.user_id,
        follow.x_user_id,
        follow.source_post_id,
        JSON.stringify({
          username: follow.username,
        }),
      ]
    );

    res.status(201).json({
      follow,
    });
  } catch (error) {
    console.error(error);

    if (error.code === "23505") {
      return res.status(409).json({
        error: "This X account is already being tracked",
      });
    }

    res.status(500).json({
      error: "Failed to create follow",
    });
  }
});


app.post("/api/follows/unfollow", async (req, res) => {
  const client = await pool.connect();

  try {
    const { follow_id } = req.body;

    if (!follow_id) {
      return res.status(400).json({
        error: "follow_id is required",
      });
    }

    await client.query("BEGIN");

    const followResult = await client.query(
      `UPDATE follows
       SET current_status = 'UNFOLLOWED',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [follow_id]
    );

    if (followResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        error: "Follow not found",
      });
    }

    const follow = followResult.rows[0];

    await client.query(
      `INSERT INTO relationship_events
       (id, user_id, x_user_id, event_type, source_post_id, metadata)
       VALUES ($1, $2, $3, 'UNFOLLOWED', $4, $5)`,
      [
        crypto.randomUUID(),
        follow.user_id,
        follow.x_user_id,
        follow.source_post_id,
        JSON.stringify({
          username: follow.username,
        }),
      ]
    );

    await client.query("COMMIT");

    res.json({
      follow,
      event: "UNFOLLOWED",
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(error);

    res.status(500).json({
      error: "Failed to record unfollow",
    });
  } finally {
    client.release();
  }
});

async function cleanupOldNetworkingPosts() {
  try {
    const result = await pool.query(
      `DELETE FROM networking_posts
       WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '90 days'
         AND NOT EXISTS (
           SELECT 1
           FROM follows
           WHERE follows.source_post_id = networking_posts.id
         )
         AND NOT EXISTS (
           SELECT 1
           FROM relationship_events
           WHERE relationship_events.source_post_id = networking_posts.id
         )`
    );

    if (result.rowCount > 0) {
      console.log(
        `[XFI] Retention cleanup removed ${result.rowCount} old networking posts`
      );
    }
  } catch (error) {
    console.error("[XFI] Retention cleanup failed:", error);
  }
}

app.post("/api/follow-checks", async (req, res) => {
  try {
    const {
      follow_id,
      status,
      attempt,
      error,
    } = req.body;

    if (!follow_id || !status || !attempt) {
      return res.status(400).json({
        error: "follow_id, status and attempt are required",
      });
    }

    const result = await pool.query(
      `INSERT INTO follow_checks
       (id, follow_id, status, attempt, error)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        crypto.randomUUID(),
        follow_id,
        status,
        attempt,
        error || null,
      ]
    );

    // Update the current state of the follow
    await pool.query(
      `UPDATE follows
       SET current_status = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [status, follow_id]
    );

    if (status === "FOLLOWED_BACK") {
      const followResult = await pool.query(
        `SELECT user_id, x_user_id, source_post_id, username
         FROM follows
         WHERE id = $1`,
        [follow_id]
      );

      const follow = followResult.rows[0];
      if (follow) {
        await pool.query(
          `INSERT INTO relationship_events
           (id, user_id, x_user_id, event_type, source_post_id, metadata)
           VALUES ($1, $2, $3, 'FOLLOW_BACK_DETECTED', $4, $5)`,
          [
            crypto.randomUUID(),
            follow.user_id,
            follow.x_user_id,
            follow.source_post_id,
            JSON.stringify({
              username: follow.username,
            }),
          ]
        );
      }
    }

    res.status(201).json({
      check: result.rows[0],
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Failed to create follow check",
    });
  }
});

const PORT = 3000;

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  cleanupOldNetworkingPosts();
  setInterval(cleanupOldNetworkingPosts, 24 * 60 * 60 * 1000);
});