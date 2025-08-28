const { DynamoDBClient, PutItemCommand } = require("@aws-sdk/client-dynamodb");

const TOP_N = 5;
const TABLE_NAME = process.env.TABLE_NAME;
const ddb = new DynamoDBClient({});

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "pulse-lambda/1.0" } });
  if (!res.ok) {
    const text = await res.text().catch(() => "<no body>");
    throw new Error(`HTTP ${res.status} fetching ${url} – body: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": "pulse-lambda/1.0" } });
  if (!res.ok) {
    const text = await res.text().catch(() => "<no body>");
    throw new Error(`HTTP ${res.status} ${url} - ${text.slice(0, 120)}`);
  }

  return res.text();
}

function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }

  return Math.abs(h).toString(36);
}

function decode(s) {
  return s
    .replaceAll(/&amp;/g, "&")
    .replaceAll(/&lt;/g, "<")
    .replaceAll(/&gt;/g, ">")
    .replaceAll(/&quot;/g, '"')
    .replaceAll(/&#39;/g, "'");
}

function firstTagText(chunk, tag) {
  const m =
    chunk.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[(.*?)\\]\\]></${tag}>`, "i")) ||
    chunk.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? decode(m[1].trim()) : null;
}

function extractLink(chunk) {
  // Atom preferred: rel="alternate"
  const alt = chunk.match(/<link[^>]*\brel=["']alternate["'][^>]*\bhref=["']([^"']+)["'][^>]*\/?>/i);
  if (alt?.[1]) return alt[1].trim();

  // Any Atom link with href
  const any = chunk.match(/<link[^>]*\bhref=["']([^"']+)["'][^>]*\/?>/i);
  if (any?.[1]) return any[1].trim();

  // RSS link text
  const text =
    chunk.match(/<link><!\[CDATA\[(.*?)\]\]><\/link>/i) ||
    chunk.match(/<link>(.*?)<\/link>/i);
  if (text?.[1]) return decode(text[1].trim());

  return null;
}

function parseFeedItems(xml, limit = 5) {
  let blocks = xml.match(/<item[\s\S]*?<\/item>/gi);
  let mode = "rss";

  if (!blocks || blocks.length === 0) {
    blocks = xml.match(/<entry[\s\S]*?<\/entry>/gi);
    mode = "atom";
  }

  const out = [];
  if (!blocks) return out;

  for (const block of blocks) {
    const title = firstTagText(block, "title");
    const link = extractLink(block);
    const guid =
      firstTagText(block, mode === "rss" ? "guid" : "id") ||
      link ||
      title;

    if (title && (link || guid)) {
      out.push({ title, url: link || null, guid: guid || link || title });
      if (out.length >= limit) break;
    }
  }
  return out;
}

async function fetchHackerNews(n = TOP_N) {
  const ids = await fetchJson("https://hacker-news.firebaseio.com/v0/topstories.json");
  const top = Array.isArray(ids) ? ids.slice(0, n) : [];
  const stories = await Promise.all(
    top.map(async (id) => {
      const item = await fetchJson(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
      return {
        id: `hn-${id}`,
        title: item?.title ?? "(no title)",
        url: item?.url ?? null,
        source: "hackernews",
        ts: Date.now(),
      };
    })
  );
  return stories;
}

async function fetchBBC(n = TOP_N) {
  const xml = await fetchText("http://feeds.bbci.co.uk/news/world/rss.xml");
  const items = parseFeedItems(xml, n);
  return items.map((it) => ({
    id: `bbc-${hash(it.guid || it.url || it.title)}`,
    title: it.title,
    url: it.url,
    source: "bbc",
    ts: Date.now()
  }));
}

async function fetchVerge(n = TOP_N) {
  const xml = await fetchText("https://www.theverge.com/rss/index.xml");
  const items = parseFeedItems(xml, n);
  return items.map((it) => ({
    id: `verge-${hash(it.guid || it.url || it.title)}`,
    title: it.title,
    url: it.url,
    source: "verge",
    ts: Date.now()
  }));
}

async function saveIfNew(item) {
  const cmd = new PutItemCommand({
    TableName: TABLE_NAME,
    Item: {
      id: { S: item.id },
      title: { S: item.title },
      source: { S: item.source },
      ts: { N: String(item.ts) },
      ...(item.url ? { url: { S: item.url } } : {})
    },
    ConditionExpression: "attribute_not_exists(id)"
  });

  try {
    await ddb.send(cmd);
    console.log(`[Pulse] Saved: ${item.id}`);
    return true;
  } catch (err) {
    if (err?.name === "ConditionalCheckFailedException") {
      console.log(`[Pulse] Skipped (duplicate): ${item.id}`);
      return false;
    }
    throw err;
  }
}

exports.handler = async () => {
  const now = new Date().toISOString();
  console.log(`[Pulse] Multi-source run at ${now}; table=${TABLE_NAME}`);
  if (!TABLE_NAME) throw new Error("TABLE_NAME not set");

  try {
    const [hnRes, bbcRes, vergeRes] = await Promise.allSettled([
      fetchHackerNews(TOP_N),
      fetchBBC(TOP_N),
      fetchVerge(TOP_N)
    ]);

    const lists = [];
    for (const [name, res] of [
      ["hn", hnRes],
      ["bbc", bbcRes],
      ["verge", vergeRes],
    ]) {
      if (res.status === "fulfilled") {
        console.log(`[Pulse] ${name} pulled ${res.value.length}`);
        lists.push(res.value);
      } else {
        console.error(`[Pulse] ${name} failed:`, res.reason?.message || res.reason);
      }
    }

    const all = lists.flat();
    let saved = 0;
    for (const item of all) {
      const ok = await saveIfNew(item);
      if (ok) saved++;
    }

    console.log(`[Pulse] Done. Pulled ${all.length}, saved ${saved}.`);
    return { ok: true, pulled: all.length, saved, at: now };
  } catch (err) {
    console.error("[Pulse] Run failed:", err?.message || err);
    throw err;
  }
};
