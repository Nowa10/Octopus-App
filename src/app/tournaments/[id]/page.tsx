'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import MatchList from '@/app/components/MatchList';

type Tournament = {
    id: string;
    name: string;
    code: string;
    created_at?: string;
};

export default function TournamentDetail() {
    const params = useParams<{ id: string }>();
    const id = params.id;

    const [tournament, setTournament] = useState<Tournament | null>(null);
    const [codeInput, setCodeInput] = useState('');
    const [canEdit, setCanEdit] = useState(false);

    const loadTournament = useCallback(async () => {
        const { data } = await supabase
            .from('tournaments')
            .select('*')
            .eq('id', id)
            .single();
        setTournament((data as Tournament) ?? null);
    }, [id]);

    useEffect(() => {
        loadTournament();
    }, [loadTournament]);

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

    if (!tournament) {
        return <main style={{ padding: 20 }}>Chargement…</main>;
    }

    return (
        <main style={{ display: 'grid', gap: 16, padding: 20, maxWidth: 900 }}>
            <h1>{tournament.name}</h1>

            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                    placeholder="Entrer le code pour modifier"
                    value={codeInput}
                    onChange={(e) => setCodeInput(e.target.value)}
                />
                <button onClick={checkCode}>Valider</button>
                {canEdit && <span style={{ color: 'green' }}>Mode édition</span>}
            </div>

            <p style={{ opacity: 0.7 }}>
                Sans code : lecture seule. Avec code : tu peux marquer les vainqueurs, etc.
            </p>

            <MatchList tournamentId={id} canEdit={canEdit} />
        </main>
    );
}
