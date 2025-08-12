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

    // Sélections en attente de validation: matchId -> winnerId
    const [pending, setPending] = useState<Record<string, string>>({});

    // Anti-spam
    const [lastClick, setLastClick] = useState(0);
    function safeAction(fn: () => void) {
        const now = Date.now();
        if (now - lastClick < 400) return;
        setLastClick(now);
        fn();
    }

    // ------- Data load -------
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

    const label = (id: string | null) =>
        id ? `${people[id]?.first_name || '?'} ${people[id]?.last_name || ''}` : 'BYE';

    // ------- Bracket UI helpers -------
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
        for (const r of byRound.keys()) {
            byRound.get(r)!.sort((a, b) => a.slot - b.slot);
        }
        return [...byRound.entries()].sort((a, b) => a[0] - b[0]);
    }, [bracketMatches]);

    // =========================================
    // ========== LOGIQUE TOURNOI ==============
    // =========================================

    // charge les matchs d’un round/type, triés par slot
    async function fetchRound(
        tId: string,
        bracket: 'winner' | 'loser',
        round: number
    ): Promise<M[]> {
        const { data } = await supabase
            .from('matches')
            .select('*')
            .eq('tournament_id', tId)
            .eq('bracket_type', bracket)
            .eq('round', round)
            .order('slot', { ascending: true });
        return data || [];
    }

    // round de départ (souvent 1) et nb de matchs de ce round
    async function getFirstRoundInfo(tId: string) {
        const { data } = await supabase
            .from('matches')
            .select('round')
            .eq('tournament_id', tId)
            .eq('bracket_type', 'winner');

        if (!data || data.length === 0) return { firstRound: 1, firstCount: 0 };

        const allRounds = data.map((x) => x.round);
        const firstRound = Math.min(...allRounds);

        const { data: r1 } = await supabase
            .from('matches')
            .select('id')
            .eq('tournament_id', tId)
            .eq('bracket_type', 'winner')
            .eq('round', firstRound);

        const firstCount = r1?.length ?? 0;
        return { firstRound, firstCount };
    }

    // max round "théorique" du WB (en fonction du nombre de matchs du 1er round)
    async function getPlannedWinnerFinalRound(tId: string): Promise<number> {
        const { firstCount } = await getFirstRoundInfo(tId);
        if (firstCount <= 1) return 1;
        const B = Math.max(2, firstCount * 2); // joueurs ~ 2 par match du 1er round
        const maxR = Math.ceil(Math.log2(B));
        return maxR; // ex: 8 joueurs => 3 (QF=1, SF=2, F=3)
    }

    // récupère (ou crée) un match précis
    async function ensureMatch(
        tId: string,
        bracket: 'winner' | 'loser',
        round: number,
        slot: number
    ): Promise<M> {
        const { data: existing } = await supabase
            .from('matches')
            .select('*')
            .eq('tournament_id', tId)
            .eq('bracket_type', bracket)
            .eq('round', round)
            .eq('slot', slot)
            .limit(1);

        if (existing && existing[0]) return existing[0] as M;

        const { data: created, error } = await supabase
            .from('matches')
            .insert({
                tournament_id: tId,
                bracket_type: bracket,
                round,
                slot,
                status: 'pending',
                player1: null,
                player2: null,
                winner: null,
            })
            .select('*')
            .single();

        if (error) throw error;
        return created as M;
    }

    // place un joueur sur un match précis (position contrôlée)
    async function setPlayerOnMatch(
        tId: string,
        bracket: 'winner' | 'loser',
        round: number,
        slot: number,
        playerId: string,
        prefer: 'player1' | 'player2' | 'auto' = 'auto'
    ) {
        const m = await ensureMatch(tId, bracket, round, slot);

        let update: Partial<M> | null = null;
        if (prefer === 'player1') {
            update = { player1: playerId };
        } else if (prefer === 'player2') {
            update = { player2: playerId };
        } else {
            if (!m.player1) update = { player1: playerId };
            else update = { player2: playerId };
        }

        await supabase.from('matches').update(update).eq('id', m.id);
    }

    // Construit le squelette du loser bracket (LB1, LB2, LB3)
    async function ensureLoserSkeleton(tId: string) {
        const maxWB = await getPlannedWinnerFinalRound(tId);
        if (maxWB < 3) return; // pas de QF/SF => pas de bronze

        // On déduit le nb de QF à partir du 1er round
        const { firstRound, firstCount } = await getFirstRoundInfo(tId);
        // Si le 1er round est déjà des QF (cas N=8), firstCount = 4
        // Si ce n'est pas le cas (N=16, R16 d'abord), quand on arrivera au QF on aura round=2

        const qfCount = 4; // structure LB dépend des QF => on sait qu'il y en a 4 pour un bracket à 8
        // Pour des brackets supérieurs (16-> QF = 8), on calcule proprement:
        const derivedQFCount = Math.max(2, Math.pow(2, Math.max(0, maxWB - 3))); // 8->4, 16->8, 32->16
        const realQFCount = derivedQFCount;

        const lb1Matches = Math.max(1, realQFCount / 2);

        // LB1 : slots 1..lb1Matches
        for (let slot = 1; slot <= lb1Matches; slot++) {
            await ensureMatch(tId, 'loser', 1, slot);
        }
        // LB2 : deux matches (correspondent aux deux demies)
        await ensureMatch(tId, 'loser', 2, 1);
        await ensureMatch(tId, 'loser', 2, 2);
        // LB3 : petite finale
        await ensureMatch(tId, 'loser', 3, 1);
    }

    // ---------- Propagations déterministes ----------

    // WB : vainqueur -> round suivant, slot déterministe
    async function propagateWinnerWB(m: M, winnerId: string) {
        const nextRound = m.round + 1;
        const nextSlot = Math.ceil(m.slot / 2); // 1→1, 2→1, 3→2, 4→2, ...
        const prefer = m.slot % 2 === 1 ? 'player1' : 'player2';
        await setPlayerOnMatch(m.tournament_id, 'winner', nextRound, nextSlot, winnerId, prefer);
    }

    // QF -> LB1 : croisement anti re-match
    async function propagateLoserFromQFToLB1(m: M, loserId: string) {
        const tId = m.tournament_id;
        const maxWB = await getPlannedWinnerFinalRound(tId);
        const qfRound = maxWB - 2;
        if (m.round !== qfRound) return;

        const qfs = await fetchRound(tId, 'winner', qfRound); // triés par slot
        const qfIndex = qfs.findIndex((x) => x.id === m.id) + 1; // 1..qfCount
        const qfCount = qfs.length; // 4, 8, ...
        const group = qfCount / 2; // 2, 4, ...

        // pairing croisé : (1↔1+group), (2↔2+group), ...
        let lb1Slot = qfIndex;
        let prefer: 'player1' | 'player2' = 'player1';
        if (qfIndex > group) {
            lb1Slot = qfIndex - group;
            prefer = 'player2';
        }
        await setPlayerOnMatch(tId, 'loser', 1, lb1Slot, loserId, prefer);
    }

    // SF -> LB2 : injection opposée (perdant DF1 va en LB2 slot 2, perdant DF2 va en LB2 slot 1)
    async function propagateLoserFromSFToLB2(m: M, loserId: string) {
        const tId = m.tournament_id;
        const maxWB = await getPlannedWinnerFinalRound(tId);
        const sfRound = maxWB - 1;
        if (m.round !== sfRound) return;

        const sfs = await fetchRound(tId, 'winner', sfRound); // 2 matches
        const sfIndex = sfs.findIndex((x) => x.id === m.id) + 1; // 1 ou 2

        const targetSlot = sfIndex === 1 ? 2 : 1; // opposé
        await setPlayerOnMatch(tId, 'loser', 2, targetSlot, loserId, 'auto');
    }

    // LB : vainqueur -> round+1, slot contrôlé
    async function propagateWinnerLB(m: M, winnerId: string) {
        if (m.round === 1) {
            // G(LB1 slot k) -> LB2 slot k
            await setPlayerOnMatch(m.tournament_id, 'loser', 2, m.slot, winnerId, 'auto');
        } else if (m.round === 2) {
            // G(LB2) -> LB3 (petite finale) slot 1
            await setPlayerOnMatch(m.tournament_id, 'loser', 3, 1, winnerId, 'auto');
        } else {
            // LB3 gagné = 3e place
        }
    }

    // ---------- Application d’un vainqueur (écriture DB + propagation) ----------
    async function applyWinner(m: M, winnerId: string) {
        const loserId = m.player1 === winnerId ? m.player2 : m.player1;

        // 1) marquer le match
        await supabase.from('matches').update({ winner: winnerId, status: 'done' }).eq('id', m.id);

        // 2) squelette LB (idempotent)
        await ensureLoserSkeleton(m.tournament_id);

        // 3) Propagations
        if (m.bracket_type === 'winner') {
            // Propager le vainqueur WB -> round suivant tant qu’on n’est pas en finale.
            const plannedMax = await getPlannedWinnerFinalRound(m.tournament_id);
            // on considère "finale" si ce round contient 1 seul match
            const thisRound = await fetchRound(m.tournament_id, 'winner', m.round);
            const isFinal = thisRound.length === 1 || m.round >= plannedMax;

            if (!isFinal) {
                await propagateWinnerWB(m, winnerId);
            }

            if (loserId) {
                const qfRound = plannedMax - 2;
                const sfRound = plannedMax - 1;
                if (m.round === qfRound) {
                    await propagateLoserFromQFToLB1(m, loserId);
                } else if (m.round === sfRound) {
                    await propagateLoserFromSFToLB2(m, loserId);
                }
            }
        } else {
            await propagateWinnerLB(m, winnerId);
            // perdant LB éliminé
        }

        // 4) Bonus palmarès si finale WB
        const plannedMax = await getPlannedWinnerFinalRound(m.tournament_id);
        const thisRound = await fetchRound(m.tournament_id, 'winner', m.round);
        const isFinal = m.bracket_type === 'winner' && (thisRound.length === 1 || m.round >= plannedMax);
        if (isFinal) {
            const { data: prof } = await supabase
                .from('profiles')
                .select('wins')
                .eq('id', winnerId)
                .single();
            const current = prof?.wins || 0;
            await supabase.from('profiles').update({ wins: current + 1 }).eq('id', winnerId);
        }
    }

    // ---------- Toolbar de validation ----------
    const pendingCount = Object.keys(pending).length;

    function selectWinner(m: M, winnerId: string) {
        if (m.status === 'done') return;
        setPending((prev) => ({ ...prev, [m.id]: winnerId }));
    }

    function clearPending() {
        setPending({});
    }

    async function confirmPending() {
        if (pendingCount === 0) return;

        // Appliquer dans un ordre stable: WB avant LB, round croissant, slot croissant
        const items: { m: M; winnerId: string }[] = [];
        for (const [matchId, winnerId] of Object.entries(pending)) {
            const m = matches.find((x) => x.id === matchId);
            if (m && winnerId) items.push({ m, winnerId });
        }

        items.sort((a, b) => {
            if (a.m.bracket_type !== b.m.bracket_type) {
                return a.m.bracket_type === 'winner' ? -1 : 1;
            }
            if (a.m.round !== b.m.round) return a.m.round - b.m.round;
            return a.m.slot - b.m.slot;
        });

        for (const it of items) {
            await applyWinner(it.m, it.winnerId);
        }

        setPending({});
        await load();
    }

    const reset = async (m: M) => {
        await supabase.from('matches').update({ winner: null, status: 'pending' }).eq('id', m.id);
        await load();
    };

    // =========================================
    // ================= UI ====================
    // =========================================
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

            {/* Toolbar validation */}
            {canEdit && pendingCount > 0 && (
                <div
                    style={{
                        display: 'flex',
                        gap: 8,
                        alignItems: 'center',
                        background: '#0b1220',
                        border: '1px solid #334155',
                        padding: '8px 12px',
                        borderRadius: 8,
                    }}
                >
                    <span>{pendingCount} victoire(s) en attente</span>
                    <button onClick={() => safeAction(confirmPending)} style={{ marginLeft: 'auto' }}>
                        Confirmer
                    </button>
                    <button onClick={() => safeAction(clearPending)}>Annuler</button>
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
                {rounds.length === 0 && <div style={{ opacity: 0.7 }}>Aucun match dans ce bracket.</div>}

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

                        {items.map((m) => {
                            const pendingWinner = pending[m.id];
                            const isSelectedP1 = pendingWinner && pendingWinner === m.player1;
                            const isSelectedP2 = pendingWinner && pendingWinner === m.player2;

                            return (
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
                                    <div style={{ fontWeight: 600, marginBottom: 8 }}>Match {m.slot}</div>

                                    {/* joueurs */}
                                    <div style={{ display: 'grid', gap: 6 }}>
                                        <div
                                            style={{
                                                display: 'flex',
                                                justifyContent: 'space-between',
                                                background:
                                                    m.status === 'done'
                                                        ? m.winner === m.player1
                                                            ? '#064e3b'
                                                            : '#1f2937'
                                                        : isSelectedP1
                                                            ? '#065f46'
                                                            : '#1f2937',
                                                padding: '6px 8px',
                                                borderRadius: 6,
                                            }}
                                        >
                                            <span>{label(m.player1)}</span>
                                            {canEdit && m.player1 && m.status !== 'done' && (
                                                <button onClick={() => safeAction(() => selectWinner(m, m.player1 as string))}>
                                                    Gagnant
                                                </button>
                                            )}
                                        </div>

                                        <div
                                            style={{
                                                display: 'flex',
                                                justifyContent: 'space-between',
                                                background:
                                                    m.status === 'done'
                                                        ? m.winner === m.player2
                                                            ? '#064e3b'
                                                            : '#1f2937'
                                                        : isSelectedP2
                                                            ? '#065f46'
                                                            : '#1f2937',
                                                padding: '6px 8px',
                                                borderRadius: 6,
                                            }}
                                        >
                                            <span>{label(m.player2)}</span>
                                            {canEdit && m.player2 && m.status !== 'done' && (
                                                <button onClick={() => safeAction(() => selectWinner(m, m.player2 as string))}>
                                                    Gagnant
                                                </button>
                                            )}
                                        </div>
                                    </div>

                                    {/* statut / actions */}
                                    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                                        {m.status === 'done' ? (
                                            <div>
                                                ✅ Vainqueur : <b>{label(m.winner)}</b>
                                            </div>
                                        ) : pendingWinner ? (
                                            <div style={{ opacity: 0.9 }}>Sélectionné : {label(pendingWinner)}</div>
                                        ) : (
                                            <div style={{ opacity: 0.7 }}>—</div>
                                        )}
                                        {canEdit && (
                                            <button style={{ marginLeft: 'auto' }} onClick={() => safeAction(() => reset(m))}>
                                                Réinitialiser
                                            </button>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                ))}
            </div>
        </div>
    );
}
