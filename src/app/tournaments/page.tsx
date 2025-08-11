'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import TournamentCreate from '@/components/TournamentCreate';

export default function TournamentsPage() {
    const [list, setList] = useState<any[]>([]);

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
                    <a
                        key={t.id}
                        href={`/tournaments/${t.id}`}
                        style={{
                            border: '1px solid #ddd',
                            padding: 10,
                            borderRadius: 8,
                        }}
                    >
                        {t.name}
                    </a>
                ))}
            </div>
        </main>
    );
}
