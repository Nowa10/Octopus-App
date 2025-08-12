'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import MatchList from '@/app/components/MatchList';
import { Button, Card } from '@/app/components/ui';

type Tournament = { id: string; name: string; code: string; created_at?: string };

export default function TournamentDetail() {
    const params = useParams<{ id: string }>();
    const id = params.id;

    const [tournament, setTournament] = useState<Tournament | null>(null);
    const [codeInput, setCodeInput] = useState('');
    const [canEdit, setCanEdit] = useState(false);

    const loadTournament = useCallback(async () => {
        const { data } = await supabase.from('tournaments').select('*').eq('id', id).single();
        setTournament((data as Tournament) ?? null);
    }, [id]);

    useEffect(() => { loadTournament(); }, [loadTournament]);

    useEffect(() => {
        const saved = localStorage.getItem(`code:${id}`);
        if (saved) setCodeInput(saved);
    }, [id]);

    const checkCode = () => {
        if (!tournament) return;
        const ok = codeInput.trim() === tournament.code;
        setCanEdit(ok);
        if (ok) localStorage.setItem(`code:${id}`, codeInput.trim());
        else alert('Code incorrect');
    };

    if (!tournament) return <main>Chargement…</main>;

    return (
        <>
            <h1 className="section-title">{tournament.name}</h1>

            <Card title="Mode édition">
                <div className="hstack">
                    <input
                        className="input"
                        placeholder="Entrer le code pour modifier"
                        value={codeInput}
                        onChange={(e) => setCodeInput(e.target.value)}
                    />
                    <Button variant="primary" onClick={checkCode}>Valider</Button>
                    {canEdit && <span className="badge">Mode édition</span>}
                </div>
                <div style={{ opacity: .7, marginTop: 8 }}>
                    Sans code : lecture seule. Avec code : tu peux marquer les vainqueurs, etc.
                </div>
            </Card>

            <MatchList tournamentId={id} canEdit={canEdit} />
        </>
    );
}
