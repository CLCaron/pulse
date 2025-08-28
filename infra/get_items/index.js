const { DynamoDBClient, ScanCommand } = require("@aws-sdk/client-dynamodb");

const ddb = new DynamoDBClient({});
const TABLE_NAME = process.env.TABLE_NAME;
const DEFAULT_LIMIT = 20;

function toJs(item) {
    return {
        id: item.id?.S,
        title: item.title?.S,
        url: item.url?.S ?? null,
        source: item.source?.S,
        ts: item.ts ? Number(item.ts.N) : null,
    }
}

exports.handler = async (event) => {
    try {
        const qs = event?.queryStringParameters || {};
        const limit = Math.min(Number(qs.limit || DEFAULT_LIMIT), 50);
        const source = qs.source || null;

        const data = await ddb.send(new ScanCommand({ TableName: TABLE_NAME }));

        let items = (data.Items || []).map(toJs);

        if (source) items = items.filter((x) => x.source === source);
        items.sort((a, b) => (b.ts || 0) - (a.ts || 0));
        items = items.slice(0, limit);

        return {
            statusCode: 200,
            headers: {
                "content-type": "application/json",
                "access-control-allow-origin": "*",
                "access-control-allow-headers": "content-type",
                "access-control-allow-methods": "GET,OPTIONS"
            },
            body: JSON.stringify(items),
        };
    } catch (err) {
        console.error("[Pulse] get-items failed: ", err?.message || err);
        return {
            statusCode: 500,
            headers: {
                "content-type": "application/json",
                "access-control-allow-origin": "*",
                "access-control-allow-headers": "content-type",
                "access-control-allow-methods": "GET,OPTIONS"
            },
            body: JSON.stringify({ error: "server_error" }),
        };
    }
};

