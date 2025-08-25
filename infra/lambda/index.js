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

async function getTopStories(n = TOP_N) {
  const ids = await fetchJson("https://hacker-news.firebaseio.com/v0/topstories.json");
  if (!Array.isArray(ids)) {
    console.error("[Pulse] Unexpected topstories payload type:", typeof ids, ids);
    throw new Error("Topstories payload is not an array");
  }
  const topIds = ids.slice(0, n);

  const stories = await Promise.all(
    topIds.map(async (id) => {
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

async function saveIfNew(item) {
  const cmd = new PutItemCommand({
    TableName: TABLE_NAME,
    Item: {
      id:     { S: item.id },
      title:  { S: item.title },
      source: { S: item.source },
      ts:     { N: String(item.ts) },
      ...(item.url ? { url: { S: item.url } } : {})
    },
    ConditionExpression: "attribute_not_exists(id)" // idempotency
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
  console.log(`[Pulse] Fetch+Save run at ${now}; table=${TABLE_NAME}`);

  try {
    const stories = await getTopStories(TOP_N);
    let saved = 0;
    for (const s of stories) {
      const ok = await saveIfNew(s);
      if (ok) saved++;
    }
    console.log(`[Pulse] Done. Pulled ${stories.length}, saved ${saved}.`);
    return { ok: true, saved, total: stories.length, at: now };
  } catch (err) {
    console.error("[Pulse] Run failed:", err?.message || err);
    throw err;
  }
};
