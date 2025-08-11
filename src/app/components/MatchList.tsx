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
    bracket_type: 'winner' | 'loser';
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
    const [tournamentCode, setTournamentCode] = useState<string | null>(null);

    // --- Rate limit anti-spam ---
    const [lastClick, setLastClick] = useState(0);
    function safeAction(fn: () => void) {
        const now = Date.now();
        if (now - lastClick < 1200) return; // 1.2s mini entre actions
        setLastClick(now);
        fn();
    }

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
        (ps || []).forEach((p) => (map[p.id] = p as P));
        setPeople(map);
    };

    useEffect(() => {
        supabase
            .from('tournaments')
            .select('code')
            .eq('id', tournamentId)
            .single()
            .then(({ data }) => setTournamentCode(data?.code || null));
    }, [tournamentId]);

    useEffect(() => {
        load();
    }, [tournamentId]);

    const label = (id: string | null) =>
        id ? `${people[id]?.first_name || '?'} ${people[id]?.last_name || ''}` : 'BYE';

    const setWinner = async (m: M, winnerId: string | null) => {
        if (!winnerId) return;

        const loserId = m.player1 === winnerId ? m.player2 : m.player1;

        // 1) Marquer le match
        await supabase
            .from('matches')
            .update({ winner: winnerId, status: 'done' })
            .eq('id', m.id);

        // 2) Propagation Winner / Loser
        if (m.bracket_type === 'winner') {
            await addPlayerToNextMatch('winner', m.round + 1, winnerId);
            if (loserId) {
                await addPlayerToNextMatch('loser', calcLoserBracketRound(m.round), loserId);
            }
        } else {
            // loser bracket
            await addPlayerToNextMatch('loser', m.round + 1, winnerId);
            // perdant éliminé → rien à faire pour lui
        }

        // 3) Bonus : si c'est la finale du tournoi (round max global), +1 win
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
            await supabase.from('profiles').update({ wins: current + 1 }).eq('id', winnerId);
        }

        load();
    };

    async function addPlayerToNextMatch(
        bracket: 'winner' | 'loser',
        round: number,
        playerId: string
    ) {
        // On cherche un match du prochain round avec un slot libre (player2 null)
        let { data: nextMatch } = await supabase
            .from('matches')
            .select('*')
            .eq('tournament_id', tournamentId)
            .eq('bracket_type', bracket)
            .eq('round', round)
            .is('player2', null)
            .limit(1)
            .single();

        if (!nextMatch) {
            // Aucun match trouvé → on crée un nouveau match et on met le joueur en player1
            await supabase.from('matches').insert({
                tournament_id: tournamentId,
                bracket_type: bracket,
                round,
                slot: await nextSlot(bracket, round), // slot suivant
                player1: playerId,
                status: 'pending',
            });
            return;
        }

        // Il existe un match : on remplit le slot dispo
        if (!nextMatch.player1) {
            await supabase.from('matches').update({ player1: playerId }).eq('id', nextMatch.id);
        } else {
            await supabase.from('matches').update({ player2: playerId }).eq('id', nextMatch.id);
        }
    }

    async function nextSlot(bracket: 'winner' | 'loser', round: number) {
        const { data } = await supabase
            .from('matches')
            .select('slot')
            .eq('tournament_id', tournamentId)
            .eq('bracket_type', bracket)
            .eq('round', round)
            .order('slot', { ascending: false })
            .limit(1);
        const last = data?.[0]?.slot ?? 0;
        return last + 1;
    }

    function calcLoserBracketRound(winnerRound: number) {
        // Mapping minimal : WB1 -> LB1, WB2 -> LB3, WB3 -> LB5, etc.
        return (winnerRound - 1) * 2 + 1;
    }

    const reset = async (m: M) => {
        await supabase
            .from('matches')
            .update({ winner: null, status: 'pending' })
            .eq('id', m.id);
        load();
    };

    return (
        <div style={{ display: 'grid', gap: 10 }}>
            {tournamentCode && (
                <div style={{ background: '#eee', padding: '8px', textAlign: 'center' }}>
                    Code du tournoi : <b>{tournamentCode}</b>{' '}
                    <button onClick={() => navigator.clipboard.writeText(tournamentCode)}>
                        Copier
                    </button>
                </div>
            )}

            {matches.map((m) => (
                <div
                    key={m.id}
                    style={{ border: '1px solid #ddd', padding: 10, borderRadius: 8 }}
                >
                    <div>
                        <b>{m.bracket_type === 'winner' ? 'Winner Bracket' : 'Loser Bracket'}</b> — Round{' '}
                        {m.round} — Match {m.slot}
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
                                onClick={() =>
                                    m.player1 && safeAction(() => setWinner(m, m.player1))
                                }
                                disabled={!m.player1}
                            >
                                Gagnant: joueur 1
                            </button>
                            <button
                                onClick={() =>
                                    m.player2 && safeAction(() => setWinner(m, m.player2))
                                }
                                disabled={!m.player2}
                            >
                                Gagnant: joueur 2
                            </button>
                            <button onClick={() => safeAction(() => reset(m))}>
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
