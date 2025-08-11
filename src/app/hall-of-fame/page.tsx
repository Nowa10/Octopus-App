'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

type Player = {
    first_name: string;
    last_name: string | null;
    wins: number | null;
};

export default function HallOfFame() {
    const [list, setList] = useState<Player[]>([]);

    useEffect(() => {
        const loadPlayers = async () => {
            const { data } = await supabase
                .from('profiles')
                .select('first_name,last_name,wins')
                .order('wins', { ascending: false })
                .limit(50);

            setList(data || []);
        };

        loadPlayers();
    }, []);

    return (
        <main style={{ display: 'grid', gap: 12, padding: 20, maxWidth: 720 }}>
            <h1>Hall of Fame</h1>

            <div style={{ display: 'grid', gap: 8 }}>
                {list.map((p, i) => (
                    <div
                        key={`${p.first_name}-${p.last_name}-${i}`}
                        style={{
                            display: 'flex',
                            gap: 8,
                            alignItems: 'center',
                            border: '1px solid #eee',
                            padding: 8,
                            borderRadius: 8,
                        }}
                    >
                        <div style={{ width: 24, textAlign: 'right' }}>{i + 1}.</div>
                        <div style={{ fontWeight: 600 }}>
                            {p.first_name} {p.last_name || ''}
                        </div>
                        <div style={{ marginLeft: 'auto' }}>{p.wins || 0}</div>
                    </div>
                ))}
            </div>
        </main>
    );
}
