export default {
  async scheduled(event, env, ctx) {
    await syncAniList(env);
  }
};

async function syncAniList(env) {
  for (let page = 1; page <= 3; page++) {

    const mediaList = await fetchAniList(page);

    if (!mediaList || mediaList.length === 0) continue;

    for (const media of mediaList) {
      try {
        const transformed = transform(media);
        await upsertAnime(env, transformed);
      } catch (err) {
        console.error("UPSERT FAILED:", err);
        continue;
      }
    }
  }
}
async function fetchAniList(page) {

  const query = `
  query ($page: Int) {
    Page(page: $page, perPage: 50) {
      media(type: ANIME, sort: START_DATE_DESC) {
        id
        title { romaji english }
        description
        format
        status
        episodes
        duration
        seasonYear
        startDate { year month day }
        averageScore
        popularity
        genres
        rankings { rank type format }
        studios(isMain: true) {
          nodes { name }
        }
        coverImage { extraLarge }
      }
    }
  }`;

  try {
    const res = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { page } })
    });

    if (!res.ok) return [];

    const json = await res.json();

    return json?.data?.Page?.media || [];

  } catch (err) {
    return [];
  }
}

function transform(media) {

  const title =
    media.title.english || media.title.romaji;

  const slug = generateSlug(title) + "-" + media.id;

  return {
    id: slug,
    title: title,
    year: media.seasonYear || null,
    type: media.format || null,
    image: media.coverImage?.large || null,
    overview: cleanHTML(media.description),

    episodes: media.episodes || 0,
    duration: media.duration
      ? media.duration + " min"
      : null,

    audio: "SUB",
    dubbed_languages: null,

    rating: media.averageScore || null,
    popularity: media.popularity || null,

    top_genre_rank: extractTopRank(media.rankings),
    airing_status: mapStatus(media.status),

    airing_date: formatDate(media.startDate),

    studio: media.studios?.nodes?.[0]?.name || null,

    tags: JSON.stringify(media.genres || []),

    total_seasons: 1
  };
}
function generateSlug(title) {
  return title
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, "-");
}
function cleanHTML(text) {
  if (!text) return null;
  return text.replace(/<[^>]*>/g, "").substring(0, 2000);
}
function mapStatus(status) {
  if (status === "RELEASING") return "AIRING";
  if (status === "FINISHED") return "COMPLETED";
  if (status === "CANCELLED") return "DISMISSED";
  return null;
}
function formatDate(date) {
  if (!date?.year) return null;

  const month = String(date.month || 1).padStart(2, "0");
  const day = String(date.day || 1).padStart(2, "0");

  return `${date.year}-${month}-${day}`;
}
function extractTopRank(rankings) {
  if (!rankings || rankings.length === 0) return null;

  const rated = rankings.find(r => r.type === "RATED");
  const popular = rankings.find(r => r.type === "POPULAR");

  const top = rated || popular;

  if (!top) return null;

  return `Top #${top.rank}`;
}
async function upsertAnime(env, anime) {

  await env.DB.prepare(`
    INSERT INTO anime_info (
      id,
      airing_date,
      airing_status,
      audio,
      dubbed_languages,
      duration,
      episodes,
      image,
      overview,
      popularity,
      rating,
      studio,
      tags,
      title,
      top_genre_rank,
      total_seasons,
      type,
      year
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)

    ON CONFLICT(id) DO UPDATE SET
      airing_date = excluded.airing_date,
      airing_status = excluded.airing_status,
      episodes = excluded.episodes,
      popularity = excluded.popularity,
      rating = excluded.rating,
      overview = excluded.overview,
      image = excluded.image,
      updated_at = CURRENT_TIMESTAMP
  `).bind(
    anime.id,
    anime.airing_date,
    anime.airing_status,
    anime.audio,
    anime.dubbed_languages,
    anime.duration,
    anime.episodes,
    anime.image,
    anime.overview,
    anime.popularity,
    anime.rating,
    anime.studio,
    anime.tags,
    anime.title,
    anime.top_genre_rank,
    anime.total_seasons,
    anime.type,
    anime.year
  ).run();
  if (anime.tags) {
  const tags = JSON.parse(anime.tags);

  for (const tag of tags) {
    await env.DB.prepare(`
      INSERT OR IGNORE INTO anime_info_tags (anime_id, tag_name)
      VALUES (?, ?)
    `).bind(anime.id, tag).run();
  }
}
}
