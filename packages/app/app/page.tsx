import Link from "next/link";
import { API_URL } from "../lib/server";

interface Fixture {
  FixtureId: number;
  Participant1: string;
  Participant2: string;
  StartTime: number;
  Competition: string;
}

export const dynamic = "force-dynamic";

export default async function Home() {
  let fixtures: Fixture[] = [];
  let error: string | null = null;
  try {
    const res = await fetch(`${API_URL}/fixtures`, { cache: "no-store" });
    if (!res.ok) throw new Error(`API ${res.status}`);
    fixtures = ((await res.json()) as Fixture[])
      .filter((f) => f.StartTime > Date.now() - 3 * 3600_000)
      .sort((a, b) => a.StartTime - b.StartTime)
      .slice(0, 20);
  } catch (e) {
    error = (e as Error).message;
  }

  return (
    <main>
      <h2 style={{ fontSize: "1rem", opacity: 0.7 }}>Upcoming fixtures</h2>
      {error && <p style={{ color: "#ff7b72" }}>API unreachable: {error}</p>}
      <ul style={{ listStyle: "none", padding: 0 }}>
        {fixtures.map((f) => (
          <li key={f.FixtureId} style={{ margin: "0.5rem 0" }}>
            <Link
              href={`/fixture/${f.FixtureId}`}
              style={{ color: "#79c0ff", textDecoration: "none" }}
            >
              {f.Participant1} v {f.Participant2}
            </Link>{" "}
            <span style={{ opacity: 0.5 }}>
              {f.Competition} · {new Date(f.StartTime).toUTCString()}
            </span>
          </li>
        ))}
      </ul>
    </main>
  );
}
