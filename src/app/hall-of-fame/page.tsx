'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Card } from '@/app/components/ui';

type Player = { first_name: string; last_name: string | null; wins: number | null };

export default function HallOfFame() {
    const [list, setList] = useState<Player[]>([]);

    useEffect(() => {
        (async () => {
            const { data } = await supabase
                .from('profiles')
                .select('first_name,last_name,wins')
                .order('wins', { ascending: false })
                .limit(50);
            setList(data || []);
        })();
    }, []);

    return (
        <>
            <h1 className="section-title">Hall of Fame</h1>

            <Card>
                <div className="stack">
                    {list.map((p, i) => (
                        <div key={`${p.first_name}-${p.last_name}-${i}`} className="matchline">
                            <div style={{ width: 28, textAlign: 'right', opacity: .7 }}>{i + 1}.</div>
                            <div style={{ fontWeight: 700 }}>{p.first_name} {p.last_name || ''}</div>
                            <div className="spacer" />
                            <div style={{ fontWeight: 800 }}>{p.wins || 0}</div>
                        </div>
                    ))}
                </div>
            </Card>
        </>
    );
}
