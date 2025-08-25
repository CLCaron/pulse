async function getItems() {
  const url = `${process.env.NEXT_PUBLIC_API_URL}/items?limit=10`;
  const res = await fetch(url, { cache: "no-store" });

  if (!res.ok) {
    throw new Error(`API error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

export default async function Home() {
  const items = await getItems();

  return (
    <main className="max-w-2xl mx-auto p-6 space-y-4">
      <h1 className="text-2xl font-bold">PULSE - The Latest</h1>
      <ul className="space-y-3">
        {items.map((it: any) => (
          <li key={it.id} className="border rounded-lg p-3">
            <a
              href={it.url ?? "#"}
              target="_blank"
              rel="noreferrer"
              className="font-medium underline"
            >
              {it.title}
            </a>
            <div className="text-xs opacity-70">
              {it.source} · {it.ts ? new Date(it.ts).toLocaleString() : "—"}
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
