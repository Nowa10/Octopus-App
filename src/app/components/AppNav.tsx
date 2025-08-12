'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Button } from '@/app/components/ui';

const LINKS = [
    { href: '/', label: 'Accueil' },
    { href: '/participants', label: 'Participants' },
    { href: '/tournaments', label: 'Tournois' },
    { href: '/hall-of-fame', label: 'Hall of Fame' },
];

export default function AppNav() {
    const pathname = usePathname() || '/';

    return (
        <>
            {/* Top bar (desktop & tablets) */}
            <header className="topnav">
                <div className="topnav__inner">
                    <Link href="/" className="brand">
                        <span className="brand__dot" />
                        <strong>JJB Club</strong>
                    </Link>

                    <nav className="topnav__links">
                        {LINKS.map(l => {
                            const active = pathname === l.href || (l.href !== '/' && pathname.startsWith(l.href));
                            return (
                                <Link key={l.href} href={l.href} className={`topnav__link ${active ? 'is-active' : ''}`}>
                                    {l.label}
                                </Link>
                            );
                        })}
                    </nav>

                    <div className="topnav__actions">
                        <Button variant="primary" size="sm" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
                            Haut de page
                        </Button>
                    </div>
                </div>
            </header>

            {/* Bottom nav (mobile) */}
            <nav className="bottomnav">
                {LINKS.map(l => {
                    const active = pathname === l.href || (l.href !== '/' && pathname.startsWith(l.href));
                    return (
                        <Link key={l.href} href={l.href} className={`bottomnav__item ${active ? 'is-active' : ''}`}>
                            {l.label}
                        </Link>
                    );
                })}
            </nav>
        </>
    );
}
