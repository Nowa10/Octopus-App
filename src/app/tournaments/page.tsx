'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import Link from 'next/link';
import TournamentCreate from '@/app/components/TournamentCreate';
import { Card } from '@/app/components/ui';

type T = { id: string; name: string; created_at: string };

export default function TournamentsPage() {
    const [list, setList] = useState<T[]>([]);

    useEffect(() => {
        (async () => {
            const { data } = await supabase.from('tournaments').select('*').order('created_at', { ascending: false });
            setList(data || []);
        })();
    }, []);

    return (
        <>
            <h1 className="section-title">Tournois</h1>

            <Card title="Créer un tournoi">
                <TournamentCreate />
            </Card>

            <h2 className="section-title">En cours / passés</h2>
            <div className="stack">
                {list.map((t) => (
                    <Link key={t.id} href={`/tournaments/${t.id}`} className="link-card">
                        {t.name}
                    </Link>
                ))}
            </div>
        </>
    );
}
