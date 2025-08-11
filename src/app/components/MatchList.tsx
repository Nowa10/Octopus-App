'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

type P = {
    id: string;
    first_name: string;
    last_name: string | null;
    wins?: number | null;
};

type M = {
    id: string;
    tournament_id: string;
    round: number;
    slot: number;
    status: 'pending' | 'done' | 'canceled';
    player1: string | null;
    player2: string | null;
    winner: string | null;
};

export default function MatchList({
    tournamentId,
    canEdit,
}: {
    tournamentId: string;
    canEdit: boolean;
}) {
    const [matches, setMatches] = useState<M[]>([]);
    const [people, setPeople] = useState<Record<string, P>>({});

    const load = async () => {
        const { data: m } = await supabase
            .from('matches')
            .select('*')
            .eq('tournament_id', tournamentId)
            .order('round')
            .order('slot');

        setMatches(m || []);

        const { data: ps } = await supabase
            .from('profiles')
            .select('id,first_name,last_name,wins');

        const map: Record<string, P> = {};
        (ps || []).forEach((p) => {
            map[p.id] = p as P;
        });
        setPeople(map);
    };

    useEffect(() => {
        load();
    }, [tournamentId]);

    const label = (id: string | null) =>
        id ? `${people[id]?.first_name || '?'} ${people[id]?.last_name || ''}` : 'BYE';

    const setWinner = async (m: M, winnerId: string | null) => {
        await supabase
            .from('matches')
            .update({
                winner: winnerId,
                status: 'done',
            })
            .eq('id', m.id);

        // Si c'est la finale (round max), incrémente wins du vainqueur
        const { data: all } = await supabase
            .from('matches')
            .select('round')
            .eq('tournament_id', m.tournament_id);

        const maxRound = Math.max(...(all || []).map((x) => x.round), 1);

        if (m.round === maxRound && winnerId) {
            const { data: prof } = await supabase
                .from('profiles')
                .select('wins')
                .eq('id', winnerId)
                .single();

            const current = prof?.wins || 0;

            await supabase
                .from('profiles')
                .update({ wins: current + 1 })
                .eq('id', winnerId);
        }

        load();
    };

    const reset = async (m: M) => {
        await supabase
            .from('matches')
            .update({
                winner: null,
                status: 'pending',
            })
            .eq('id', m.id);

        load();
    };

    return (
        <div style={{ display: 'grid', gap: 10 }}>
            {matches.map((m) => (
                <div
                    key={m.id}
                    style={{
                        border: '1px solid #ddd',
                        padding: 10,
                        borderRadius: 8,
                    }}
                >
                    <div>
                        <b>Round {m.round}</b> — Match {m.slot}
                    </div>

                    <div
                        style={{
                            display: 'flex',
                            gap: 12,
                            alignItems: 'center',
                            marginTop: 6,
                        }}
                    >
                        <span>{label(m.player1)}</span>
                        <span>vs</span>
                        <span>{label(m.player2)}</span>
                    </div>

                    {canEdit ? (
                        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                            <button
                                onClick={() => m.player1 && setWinner(m, m.player1)}
                                disabled={!m.player1}
                            >
                                Gagnant: joueur 1
                            </button>
                            <button
                                onClick={() => m.player2 && setWinner(m, m.player2)}
                                disabled={!m.player2}
                            >
                                Gagnant: joueur 2
                            </button>
                            <button onClick={() => reset(m)}>
                                Annuler / Réinitialiser
                            </button>
                        </div>
                    ) : m.status === 'done' ? (
                        <div style={{ marginTop: 6 }}>
                            Vainqueur: <b>{label(m.winner)}</b>
                        </div>
                    ) : (
                        <div style={{ marginTop: 6, opacity: 0.6 }}>—</div>
                    )}
                </div>
            ))}
        </div>
    );
}
