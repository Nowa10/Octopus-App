import Link from 'next/link';

export default function Home() {
  return (
    <main style={{ display: 'grid', gap: 12, padding: 20 }}>
      <h1>Tournois JJB (Club)</h1>

      <div style={{ display: 'grid', gap: 8 }}>
        <Link href="/participants" style={{ border: '1px solid #ddd', padding: 10, borderRadius: 8 }}>
          Participants
        </Link>
        <Link href="/tournaments" style={{ border: '1px solid #ddd', padding: 10, borderRadius: 8 }}>
          Tournois
        </Link>
        <Link href="/hall-of-fame" style={{ border: '1px solid #ddd', padding: 10, borderRadius: 8 }}>
          Hall of Fame
        </Link>
      </div>
    </main>
  );
}