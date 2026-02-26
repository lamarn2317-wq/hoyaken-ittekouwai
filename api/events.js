const { Client } = require("@notionhq/client");

/**
 * ほやけんいってこーわい — Notion API 中継サーバー
 * Vercel Serverless Function
 *
 * 環境変数:
 *   NOTION_API_KEY      — Notion Integration トークン
 *   NOTION_DATABASE_ID  — イベントデータベースID
 */

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;

/**
 * Notionプロパティから安全に値を抽出するヘルパー
 */
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
  // Notion hosted file
  if (file.type === "file") return file.file.url;
  // External file
  if (file.type === "external") return file.external.url;
  return "";
}

/**
 * Notionページを整形されたイベントオブジェクトに変換
 */
function parseEvent(page) {
  const p = page.properties;

  // プロパティ名の候補を試す（Tallyの日本語名 or 英語名に対応）
  const name =
    getTitle(p["イベント名"]) ||
    getTitle(p["Name"]) ||
    getTitle(p["名前"]) ||
    getTitle(p["title"]) ||
    "";

  const area =
    getSelect(p["エリア"]) ||
    getSelect(p["Area"]) ||
    getSelect(p["地域"]) ||
    "";

  const startDate =
    getDate(p["開催日（開始）"]) ||
    getDate(p["開催日"]) ||
    getDate(p["Start Date"]) ||
    getDate(p["日付"]) ||
    null;

  const endDate =
    getDate(p["開催日（終了）"]) ||
    getDate(p["End Date"]) ||
    null;

  const categories =
    getMultiSelect(p["ジャンル"]) ||
    getMultiSelect(p["Genre"]) ||
    getMultiSelect(p["カテゴリ"]) ||
    [];

  const imageUrl =
    getFiles(p["イベント画像"]) ||
    getFiles(p["画像"]) ||
    getFiles(p["Image"]) ||
    getFiles(p["Cover"]) ||
    "";

  const detailUrl =
    getUrl(p["詳細URL"]) ||
    getUrl(p["URL"]) ||
    getUrl(p["リンク"]) ||
    getRichText(p["詳細URL"]) ||
    "";

  // カバー画像（Notionページカバーからのフォールバック）
  let coverUrl = imageUrl;
  if (!coverUrl && page.cover) {
    if (page.cover.type === "file") coverUrl = page.cover.file.url;
    if (page.cover.type === "external") coverUrl = page.cover.external.url;
  }

  return {
    id: page.id,
    name,
    area,
    startDate,
    endDate,
    categories,
    imageUrl: coverUrl,
    detailUrl,
    createdAt: page.created_time,
  };
}

/**
 * メインハンドラー
 */
module.exports = async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // 環境変数チェック
  if (!process.env.NOTION_API_KEY || !DATABASE_ID) {
    return res.status(500).json({
      error: "Missing environment variables",
      hint: "Set NOTION_API_KEY and NOTION_DATABASE_ID in Vercel dashboard",
    });
  }

  try {
    // Notion DBクエリ（ページネーション対応）
    let allResults = [];
    let hasMore = true;
    let startCursor = undefined;

    while (hasMore) {
      const response = await notion.databases.query({
        database_id: DATABASE_ID,
        start_cursor: startCursor,
        page_size: 100,
        sorts: [
          {
            property: "開催日（開始）",
            direction: "ascending",
          },
        ],
      });

      allResults = allResults.concat(response.results);
      hasMore = response.has_more;
      startCursor = response.next_cursor;
    }

    // イベントデータに変換
    const events = allResults
      .map(parseEvent)
      .filter((e) => e.name); // 名前なしを除外

    // キャッシュヘッダー（60秒キャッシュ、5分間stale-while-revalidate）
    res.setHeader(
      "Cache-Control",
      "s-maxage=60, stale-while-revalidate=300"
    );

    return res.status(200).json({
      events,
      totalCount: events.length,
      cachedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[ほやけん API Error]", error.message);

    // Notion API のエラー詳細
    if (error.code === "object_not_found") {
      return res.status(404).json({
        error: "Database not found",
        hint: "Check NOTION_DATABASE_ID and ensure the Integration has access to the database",
      });
    }

    if (error.code === "unauthorized") {
      return res.status(401).json({
        error: "Unauthorized",
        hint: "Check NOTION_API_KEY is correct",
      });
    }

    return res.status(500).json({
      error: "Failed to fetch events",
      message: error.message,
    });
  }
};
