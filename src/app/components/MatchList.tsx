'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
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
    const [activeBracket, setActiveBracket] = useState<'winner' | 'loser'>('winner');

    // Anti-spam bouton
    const [lastClick, setLastClick] = useState(0);
    function safeAction(fn: () => void) {
        const now = Date.now();
        if (now - lastClick < 1000) return;
        setLastClick(now);
        fn();
    }

    const load = useCallback(async () => {
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
    }, [tournamentId]);

    useEffect(() => {
        load();
    }, [load]);

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

    // ------- Bracket helpers -------
    const bracketMatches = useMemo(
        () => matches.filter((m) => m.bracket_type === activeBracket),
        [matches, activeBracket]
    );

    const rounds = useMemo(() => {
        const byRound = new Map<number, M[]>();
        for (const m of bracketMatches) {
            if (!byRound.has(m.round)) byRound.set(m.round, []);
            byRound.get(m.round)!.push(m);
        }
        // tri des matchs dans chaque round par slot
        for (const r of byRound.keys()) {
            byRound.get(r)!.sort((a, b) => a.slot - b.slot);
        }
        return [...byRound.entries()].sort((a, b) => a[0] - b[0]); // [[round, matches[]], ...]
    }, [bracketMatches]);

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
            await addPlayerToNextMatch('loser', m.round + 1, winnerId);
            // perdant loser bracket = éliminé (rien à faire)
        }

        // 3) Bonus: si finale globale, +1 win
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
        const { data: nextMatch } = await supabase
            .from('matches')
            .select('*')
            .eq('tournament_id', tournamentId)
            .eq('bracket_type', bracket)
            .eq('round', round)
            .is('player2', null)
            .limit(1)
            .single();

        if (!nextMatch) {
            await supabase.from('matches').insert({
                tournament_id: tournamentId,
                bracket_type: bracket,
                round,
                slot: await nextSlot(bracket, round),
                player1: playerId,
                status: 'pending',
            });
            return;
        }

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

    // ------- UI -------
    return (
        <div style={{ display: 'grid', gap: 12 }}>
            {/* Bannière code tournoi */}
            {tournamentCode && (
                <div
                    style={{
                        background: '#1f2937',
                        color: 'white',
                        padding: '8px 12px',
                        textAlign: 'center',
                        borderRadius: 8,
                    }}
                >
                    Code du tournoi : <b>{tournamentCode}</b>{' '}
                    <button
                        onClick={() => navigator.clipboard.writeText(tournamentCode)}
                        style={{ marginLeft: 8 }}
                    >
                        Copier
                    </button>
                </div>
            )}

            {/* Switch Winner / Loser */}
            <div style={{ display: 'flex', gap: 8 }}>
                <button
                    onClick={() => setActiveBracket('winner')}
                    style={{
                        padding: '8px 12px',
                        borderRadius: 8,
                        border: '1px solid #ddd',
                        background: activeBracket === 'winner' ? '#e5e7eb' : 'transparent',
                    }}
                >
                    Winner Bracket
                </button>
                <button
                    onClick={() => setActiveBracket('loser')}
                    style={{
                        padding: '8px 12px',
                        borderRadius: 8,
                        border: '1px solid #ddd',
                        background: activeBracket === 'loser' ? '#e5e7eb' : 'transparent',
                    }}
                >
                    Loser Bracket
                </button>
            </div>

            {/* Grille en colonnes par round */}
            <div
                style={{
                    display: 'grid',
                    gridAutoFlow: 'column',
                    gridAutoColumns: 'minmax(260px, 1fr)',
                    gap: 16,
                    alignItems: 'start',
                    overflowX: 'auto',
                    paddingBottom: 8,
                }}
            >
                {rounds.length === 0 && (
                    <div style={{ opacity: 0.7 }}>Aucun match dans ce bracket.</div>
                )}

                {rounds.map(([roundIdx, items]) => (
                    <div key={roundIdx} style={{ display: 'grid', gap: 12 }}>
                        <div
                            style={{
                                fontWeight: 700,
                                textAlign: 'center',
                                borderBottom: '1px solid #e5e7eb',
                                paddingBottom: 4,
                            }}
                        >
                            Round {roundIdx}
                        </div>

                        {items.map((m) => (
                            <div
                                key={m.id}
                                style={{
                                    border: '1px solid #ddd',
                                    borderRadius: 10,
                                    padding: 10,
                                    background: '#111827',
                                    color: 'white',
                                }}
                            >
                                <div style={{ fontWeight: 600, marginBottom: 8 }}>
                                    Match {m.slot}
                                </div>

                                {/* joueurs */}
                                <div style={{ display: 'grid', gap: 6 }}>
                                    <div
                                        style={{
                                            display: 'flex',
                                            justifyContent: 'space-between',
                                            background: m.winner === m.player1 ? '#064e3b' : '#1f2937',
                                            padding: '6px 8px',
                                            borderRadius: 6,
                                        }}
                                    >
                                        <span>{label(m.player1)}</span>
                                        {canEdit && m.player1 && (
                                            <button
                                                onClick={() =>
                                                    safeAction(() => setWinner(m, m.player1 as string))
                                                }
                                                disabled={!m.player1}
                                            >
                                                Gagnant
                                            </button>
                                        )}
                                    </div>

                                    <div
                                        style={{
                                            display: 'flex',
                                            justifyContent: 'space-between',
                                            background: m.winner === m.player2 ? '#064e3b' : '#1f2937',
                                            padding: '6px 8px',
                                            borderRadius: 6,
                                        }}
                                    >
                                        <span>{label(m.player2)}</span>
                                        {canEdit && m.player2 && (
                                            <button
                                                onClick={() =>
                                                    safeAction(() => setWinner(m, m.player2 as string))
                                                }
                                                disabled={!m.player2}
                                            >
                                                Gagnant
                                            </button>
                                        )}
                                    </div>
                                </div>

                                {/* statut / actions */}
                                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                                    {m.status === 'done' ? (
                                        <div>
                                            ✅ Vainqueur :{' '}
                                            <b>{label(m.winner)}</b>
                                        </div>
                                    ) : (
                                        <div style={{ opacity: 0.7 }}>—</div>
                                    )}
                                    {canEdit && (
                                        <button
                                            style={{ marginLeft: 'auto' }}
                                            onClick={() => safeAction(() => reset(m))}
                                        >
                                            Réinitialiser
                                        </button>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                ))}
            </div>
        </div>
    );
}
