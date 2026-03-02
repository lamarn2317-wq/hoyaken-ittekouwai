const { Client } = require("@notionhq/client");
const notion = new Client({ auth: process.env.NOTION_API_KEY });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;

function getTitle(prop) {
  if (!prop || prop.type !== "title") return "";
  return prop.title.map((t) => t.plain_text).join("") || "";
}
function getSelect(prop) {
  if (!prop || prop.type !== "select" || !prop.select) return "";
  return prop.select.name || "";
}
function getMultiSelect(prop) {
  if (!prop || prop.type !== "multi_select") return [];
  return prop.multi_select.map((s) => s.name);
}
function getDate(prop) {
  if (!prop || prop.type !== "date" || !prop.date) return null;
  return prop.date.start || null;
}
function getDateEnd(prop) {
  if (!prop || prop.type !== "date" || !prop.date) return null;
  return prop.date.end || null;
}
function getUrl(prop) {
  if (!prop || prop.type !== "url") return "";
  return prop.url || "";
}
function getRichText(prop) {
  if (!prop || prop.type !== "rich_text") return "";
  return prop.rich_text.map((t) => t.plain_text).join("") || "";
}
function getFiles(prop) {
  if (!prop || prop.type !== "files" || !prop.files.length) return "";
  const file = prop.files[0];
  if (file.type === "file") return file.file.url;
  if (file.type === "external") return file.external.url;
  return "";
}
function getAnyText(prop) {
  if (!prop) return "";
  if (prop.type === "select" && prop.select) return prop.select.name || "";
  if (prop.type === "multi_select") return prop.multi_select.map((s) => s.name).join(", ");
  if (prop.type === "rich_text") return prop.rich_text.map((t) => t.plain_text).join("") || "";
  if (prop.type === "title") return prop.title.map((t) => t.plain_text).join("") || "";
  if (prop.type === "number") return String(prop.number || "");
  return "";
}

// Notionプロパティ名の前後スペースを無視して検索
function findProp(properties, name) {
  if (properties[name]) return properties[name];
  for (const [key, val] of Object.entries(properties)) {
    if (key.trim() === name) return val;
  }
  return null;
}

function parseEvent(page) {
  const p = page.properties;
  const name = getTitle(findProp(p, "イベント名")) || getTitle(findProp(p, "Name")) || getTitle(findProp(p, "名前")) || "";
  const rawArea = getAnyText(findProp(p, "エリア")) || getAnyText(findProp(p, "Area")) || getAnyText(findProp(p, "地域")) || "";
  const area = rawArea.replace(/^[\p{Emoji}\p{Emoji_Presentation}\u200d\ufe0f]+/gu, "").trim();
  const startDate = getDate(findProp(p, "開始日")) || getDate(findProp(p, "開催日")) || getDate(findProp(p, "Start Date")) || null;
  const endDate = getDateEnd(findProp(p, "開始日")) || getDate(findProp(p, "終了日")) || getDate(findProp(p, "End Date")) || null;
  const rawCategories = getMultiSelect(findProp(p, "ジャンル")) || getMultiSelect(findProp(p, "Genre")) || getMultiSelect(findProp(p, "カテゴリ")) || [];
  const categories = rawCategories.map((c) => c.replace(/^[\p{Emoji}\p{Emoji_Presentation}\u200d\ufe0f]+/gu, "").trim());
  const imageUrl = getFiles(findProp(p, "画像")) || getFiles(findProp(p, "イベント画像")) || getFiles(findProp(p, "Image")) || "";
  const detailUrl = getUrl(findProp(p, "詳細URL")) || getUrl(findProp(p, "URL")) || getUrl(findProp(p, "リンク")) || getRichText(findProp(p, "詳細URL")) || "";
  let coverUrl = imageUrl;
  if (!coverUrl && page.cover) {
    if (page.cover.type === "file") coverUrl = page.cover.file.url;
    if (page.cover.type === "external") coverUrl = page.cover.external.url;
  }
  return { id: page.id, name, area, startDate, endDate, categories, imageUrl: coverUrl, detailUrl, createdAt: page.created_time };
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  if (!process.env.NOTION_API_KEY || !DATABASE_ID) {
    return res.status(500).json({ error: "Missing environment variables" });
  }

  // Debug mode: show raw property types
  if (req.query.debug === "1") {
    try {
      const response = await notion.databases.query({ database_id: DATABASE_ID, page_size: 1 });
      const page = response.results[0];
      if (!page) return res.status(200).json({ message: "No pages" });
      const propInfo = {};
      for (const [key, val] of Object.entries(page.properties)) {
        propInfo[key] = { type: val.type };
      }
      return res.status(200).json({ propertyNames: Object.keys(page.properties), propertyTypes: propInfo });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  try {
    let allResults = [];
    let hasMore = true;
    let startCursor = undefined;
    while (hasMore) {
      const response = await notion.databases.query({
        database_id: DATABASE_ID,
        start_cursor: startCursor,
        page_size: 100,
      });
      allResults = allResults.concat(response.results);
      hasMore = response.has_more;
      startCursor = response.next_cursor;
    }
    // 重複除去（同じイベント名は最初の1件だけ残す）
    const allEvents = allResults.map(parseEvent).filter((e) => e.name);
    const seen = new Set();
    const events = allEvents.filter((e) => {
      if (seen.has(e.name)) return false;
      seen.add(e.name);
      return true;
    });
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
    return res.status(200).json({ events, totalCount: events.length, cachedAt: new Date().toISOString() });
  } catch (error) {
    console.error("[API Error]", error.message);
    if (error.code === "object_not_found") return res.status(404).json({ error: "Database not found" });
    if (error.code === "unauthorized") return res.status(401).json({ error: "Unauthorized" });
    return res.status(500).json({ error: "Failed to fetch events", message: error.message });
  }
};
