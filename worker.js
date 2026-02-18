
export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      // ===== 1️⃣ METHOD PROTECTION =====
      if (request.method !== "GET") {
        return forbidden("Method Not Allowed", 405);
      }

      // ===== 2️⃣ BASIC BOT FILTER =====
      const ua = request.headers.get("User-Agent") || "";
      if (!ua.includes("Mozilla")) {
        return forbidden("Bots Not Allowed", 403);
      }

      // ===== 3️⃣ ORIGIN CHECK =====
      const origin = request.headers.get("Origin");
      if (origin && origin !== env.ALLOWED_ORIGIN) {
        return forbidden("Invalid Origin", 403);
      }

      // ===== 4️⃣ RATE LIMIT =====
      if (!(await rateLimit(request, env))) {
        return forbidden("Too Many Requests", 429);
      }

      // ===== ROUTES =====

      // Paginated list
      if (path === "/api/anime") {
        return await getPaginatedAnime(url, env);
      }
// Advanced search endpoint
if (path === "/api/search") {
  return await searchAnime(url, env);
}
      // Single anime (metadata only)
   if (path.startsWith("/api/anime/")) {
  const parts = path.split("/");
  if (parts.length !== 4 || !parts[3]) {
    return forbidden("Invalid Request", 400);
  }
  const id = parts[3];
  return await getAnimeDetails(env, id);
}

      // Secure episode endpoint
if (path.startsWith("/api/episode/")) {
  const parts = path.split("/");

  if (parts.length !== 5 || !parts[3] || !parts[4]) {
    return forbidden("Invalid Episode Request", 400);
  }

  const id = parts[3];
  const number = parseInt(parts[4]);

  if (isNaN(number) || number < 1 || number > 2000) {
    return forbidden("Invalid Episode Number", 400);
  }

  return await getSingleEpisodeSecure(request, env, id, number);
}

      return forbidden("Not Found", 404);

    } catch (err) {
      return forbidden("Internal Error", 500);
    }
  }
};


// ================= RATE LIMIT =================
async function rateLimit(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const key = `rl:${ip}`;

  const current = await env.RATE_LIMIT.get(key);
  const count = current ? parseInt(current) : 0;

  if (count >= 40) return false;

  await env.RATE_LIMIT.put(key, String(count + 1), { expirationTtl: 60 });
  return true;
}
async function searchAnime(url, env) {
  const q = (url.searchParams.get("q") || "").trim();
  const type = (url.searchParams.get("type") || "").trim().toLowerCase();
  const year = (url.searchParams.get("year") || "").trim();
  const tag = (url.searchParams.get("tag") || "").trim().toLowerCase();
  const page = Math.max(parseInt(url.searchParams.get("page") || "1"), 1);
  if (!q && !type && !year && !tag) {
    return forbidden("Empty Search", 400);
  }
  const limit = 20;
  const offset = (page - 1) * limit;
  let conditions = [];
  let bindings = [];
if (q) {
  conditions.push("(LOWER(title) LIKE ? OR LOWER(id) LIKE ?)");
  const lowerQ = q.toLowerCase();
  bindings.push(`%${lowerQ}%`, `%${lowerQ}%`);
}
  if (type) {
    conditions.push("LOWER(type) = ?");
    bindings.push(type);
  }

  if (year) {
    conditions.push("year = ?");
    bindings.push(year);
  }

  let sql = `
    SELECT DISTINCT anime.id, anime.title, anime.year, anime.type, anime.image, anime.duration, anime.rating
    FROM anime
  `;

  if (tag) {
    sql += `
      JOIN anime_tags ON anime.id = anime_tags.anime_id
    `;
    conditions.push("LOWER(anime_tags.tag_name) = ?");
    bindings.push(tag);
  }

  if (conditions.length) {
    sql += " WHERE " + conditions.join(" AND ");
  }

  sql += " LIMIT ? OFFSET ?";
  bindings.push(limit, offset);

  const { results } = await env.DB.prepare(sql).bind(...bindings).all();

  return json(results);
}
async function getPaginatedAnime(url, env) {
  const page = Math.max(parseInt(url.searchParams.get("page") || "1"), 1);
  const limit = 20;
  const offset = (page - 1) * limit;

  const { results } = await env.DB.prepare(`
    SELECT id, title, year, type, image, duration, rating
    FROM anime
    LIMIT ? OFFSET ?
  `).bind(limit, offset).all();

  return json(results);
}


// ================= SINGLE ANIME =================
async function getAnimeDetails(env, id) {
  const anime = await env.DB.prepare(`
    SELECT *
    FROM anime
    WHERE id = ?
  `).bind(id).first();

  if (!anime) return forbidden("Not Found", 404);

  const { results: tags } = await env.DB.prepare(`
    SELECT tag_name FROM anime_tags WHERE anime_id = ?
  `).bind(id).all();

return json({
  id: anime.id,
  title: anime.title,
  year: anime.year,
  type: anime.type,
  image: anime.image,
  url: anime.url,
  episodes: anime.episodes,
  audio: anime.audio,
  duration: anime.duration,
  watch_link: anime.watch_link,
  rating: anime.rating,
  overview: anime.overview,
  tags: tags.map(t => t.tag_name),
  social: {
    telegram: anime.telegram,
    reddit: anime.reddit
  }
});
}


// ================= SECURE EPISODES =================
async function getSingleEpisodeSecure(request, env, id, number) {
  const url = new URL(request.url);
  const ts = url.searchParams.get("ts");
  const sig = url.searchParams.get("sig");

  if (!ts || !sig) return forbidden("Missing Signature", 403);

  const now = Math.floor(Date.now() / 1000);
const timestamp = parseInt(ts);

if (isNaN(timestamp)) {
  return forbidden("Invalid Timestamp", 403);
}

if (timestamp > now || now - timestamp > 60) {
  return forbidden("Expired", 403);
}

  const expected = await sha256(id + number + ts + env.API_SECRET);
  if (expected !== sig) {
    return forbidden("Invalid Signature", 403);
  }

  const episode = await env.DB.prepare(`
    SELECT episode_number, stream_url, download_url
    FROM episode_links
    WHERE anime_id = ? AND episode_number = ?
  `).bind(id, number).first();

  if (!episode) return forbidden("Episode Not Found", 404);

  return json({
    [`E${number}`]: episode.stream_url,
    [`D${number}`]: episode.download_url
  });
}


// ================= SHA256 =================
async function sha256(message) {
  const msgUint8 = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}


// ================= JSON RESPONSE =================
function json(data) {
  return new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer"
    }
  });
}

function forbidden(msg, code) {
  return new Response(msg, { status: code });
}
