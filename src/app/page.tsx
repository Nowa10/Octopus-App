import Link from 'next/link';

export default function Home() {
  return (
    <>
      <h1 className="section-title">Tournois JJB (Club)</h1>

      <div className="stack">
        <Link href="/participants" className="link-card">Participants</Link>
        <Link href="/tournaments" className="link-card">Tournois</Link>
        <Link href="/hall-of-fame" className="link-card">Hall of Fame</Link>
      </div>
    </>
  );
}
