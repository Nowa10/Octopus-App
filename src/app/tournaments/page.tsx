'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import Link from 'next/link';
import TournamentCreate from '@/app/components/TournamentCreate';

type T = { id: string; name: string; created_at: string };

export default function TournamentsPage() {
    const [list, setList] = useState<T[]>([]);

    const load = async () => {
        const { data } = await supabase
            .from('tournaments')
            .select('*')
            .order('created_at', { ascending: false });
        setList(data || []);
    };

    useEffect(() => {
        load();
    }, []);

    return (
        <main style={{ display: 'grid', gap: 16, padding: 20, maxWidth: 900 }}>
            <h1>Tournois</h1>

            <TournamentCreate />

            <h2>En cours / passés</h2>
            <div style={{ display: 'grid', gap: 8 }}>
                {list.map((t) => (
                    <Link
                        key={t.id}
                        href={`/tournaments/${t.id}`}
                        style={{ border: '1px solid #ddd', padding: 10, borderRadius: 8 }}
                    >
                        {t.name}
                    </Link>
                ))}
            </div>
        </main>
    );
}
