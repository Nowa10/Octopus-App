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

type MinimalMatchRow = Pick<M, 'winner' | 'status' | 'tournament_id'>;

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

    // Sélections en attente
    const [pending, setPending] = useState<Record<string, string>>({});
    const pendingCount = Object.keys(pending).length;

    // Podium (après "Finir le tournoi")
    const [podium, setPodium] = useState<{
        gold?: string | null;
        silver?: string | null;
        bronze?: string | null;
        fourth?: string | null;
        note?: string;
    } | null>(null);

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

    async function getAllRounds(tId: string, bracket: 'winner' | 'loser') {
        const { data } = await supabase
            .from('matches')
            .select('round')
            .eq('tournament_id', tId)
            .eq('bracket_type', bracket);
        const arr = (data || []).map((x) => x.round);
        return { min: arr.length ? Math.min(...arr) : 0, max: arr.length ? Math.max(...arr) : 0 };
    }

    // heuristique: le "QF" d'un bracket doit exister et contenir un NOMBRE PAIR de matchs
    async function isBracketMode(tId: string): Promise<boolean> {
        const { max } = await getAllRounds(tId, 'winner');
        if (max < 1) return false;
        // On suppose que QF = max - 2 ; si <1 => pas de QF
        const qfRound = max - 2;
        if (qfRound < 1) return false;
        const qfs = await fetchRound(tId, 'winner', qfRound);
        return qfs.length >= 2 && qfs.length % 2 === 0;
    }

    // max round WB (réel, pas théorique)
    async function getActualMaxWinnerRound(tId: string): Promise<number> {
        const { max } = await getAllRounds(tId, 'winner');
        return max || 1;
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
        if (prefer === 'player1') update = { player1: playerId };
        else if (prefer === 'player2') update = { player2: playerId };
        else update = !m.player1 ? { player1: playerId } : { player2: playerId };

        await supabase.from('matches').update(update).eq('id', m.id);
    }

    // ----- Squelette loser (LB1/LB2/LB3) uniquement si QF pair -----
    async function ensureLoserSkeleton(tId: string) {
        const { max } = await getAllRounds(tId, 'winner');
        if (max < 3) return; // pas de QF/SF

        const qfRound = max - 2;
        const qfs = await fetchRound(tId, 'winner', qfRound);
        if (qfs.length < 2 || qfs.length % 2 !== 0) return; // poule => on sort

        const lb1Matches = qfs.length / 2;
        for (let slot = 1; slot <= lb1Matches; slot++) {
            await ensureMatch(tId, 'loser', 1, slot);
        }
        await ensureMatch(tId, 'loser', 2, 1);
        await ensureMatch(tId, 'loser', 2, 2);
        await ensureMatch(tId, 'loser', 3, 1);
    }

    // ---------- Propagations déterministes (BRACKET UNIQUEMENT) ----------
    async function propagateWinnerWB(m: M, winnerId: string) {
        const nextRound = m.round + 1;
        const nextSlot = Math.ceil(m.slot / 2);
        const prefer = m.slot % 2 === 1 ? 'player1' : 'player2';
        await setPlayerOnMatch(m.tournament_id, 'winner', nextRound, nextSlot, winnerId, prefer);
    }

    async function propagateLoserFromQFToLB1(m: M, loserId: string) {
        const tId = m.tournament_id;
        const { max } = await getAllRounds(tId, 'winner');
        const qfRound = max - 2;
        if (m.round !== qfRound) return;

        const qfs = await fetchRound(tId, 'winner', qfRound);
        const qfCount = qfs.length;
        if (qfCount < 2 || qfCount % 2 !== 0) return; // poule

        const qfIndex = qfs.findIndex((x) => x.id === m.id) + 1; // 1..qfCount
        const group = qfCount / 2; // entier

        let lb1Slot = qfIndex;
        let prefer: 'player1' | 'player2' = 'player1';
        if (qfIndex > group) {
            lb1Slot = qfIndex - group;
            prefer = 'player2';
        }
        await setPlayerOnMatch(tId, 'loser', 1, lb1Slot, loserId, prefer);
    }

    async function propagateLoserFromSFToLB2(m: M, loserId: string) {
        const tId = m.tournament_id;
        const { max } = await getAllRounds(tId, 'winner');
        const sfRound = max - 1;
        if (m.round !== sfRound) return;

        const sfs = await fetchRound(tId, 'winner', sfRound);
        if (sfs.length !== 2) return; // sécurité

        const sfIndex = sfs.findIndex((x) => x.id === m.id) + 1; // 1 ou 2
        const targetSlot = sfIndex === 1 ? 2 : 1; // opposé
        await setPlayerOnMatch(tId, 'loser', 2, targetSlot, loserId, 'auto');
    }

    async function propagateWinnerLB(m: M, winnerId: string) {
        if (m.round === 1) {
            await setPlayerOnMatch(m.tournament_id, 'loser', 2, m.slot, winnerId, 'auto');
        } else if (m.round === 2) {
            await setPlayerOnMatch(m.tournament_id, 'loser', 3, 1, winnerId, 'auto');
        }
    }

    // ---------- Application d’un vainqueur ----------
    async function applyWinner(m: M, winnerId: string) {
        const loserId = m.player1 === winnerId ? m.player2 : m.player1;

        // 1) marquer le match
        await supabase.from('matches').update({ winner: winnerId, status: 'done' }).eq('id', m.id);

        // 2) BRACKET uniquement
        const bracket = await isBracketMode(m.tournament_id);
        if (bracket) {
            await ensureLoserSkeleton(m.tournament_id);

            if (m.bracket_type === 'winner') {
                const maxWB = await getActualMaxWinnerRound(m.tournament_id);
                const thisRound = await fetchRound(m.tournament_id, 'winner', m.round);
                const isFinal = thisRound.length === 1 || m.round >= maxWB;

                if (!isFinal) {
                    await propagateWinnerWB(m, winnerId);
                }

                if (loserId) {
                    const qfRound = maxWB - 2;
                    const sfRound = maxWB - 1;
                    if (m.round === qfRound) await propagateLoserFromQFToLB1(m, loserId);
                    else if (m.round === sfRound) await propagateLoserFromSFToLB2(m, loserId);
                }
            } else {
                await propagateWinnerLB(m, winnerId);
            }

            // bonus palmarès si finale WB
            const maxWB2 = await getActualMaxWinnerRound(m.tournament_id);
            const thisRound2 = await fetchRound(m.tournament_id, 'winner', m.round);
            const isFinal2 = m.bracket_type === 'winner' && (thisRound2.length === 1 || m.round >= maxWB2);
            if (isFinal2) {
                const { data: prof } = await supabase
                    .from('profiles')
                    .select('wins')
                    .eq('id', winnerId)
                    .single();
                const current = prof?.wins || 0;
                await supabase.from('profiles').update({ wins: current + 1 }).eq('id', winnerId);
            }
        }
    }

    // ---------- Toolbar de validation ----------
    function selectWinner(m: M, winnerId: string) {
        if (m.status === 'done') return;
        setPending((prev) => ({ ...prev, [m.id]: winnerId }));
    }
    function clearPending() {
        setPending({});
    }
    async function confirmPending() {
        if (pendingCount === 0) return;

        // Appliquer dans un ordre stable
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

    // ---------- Finir le tournoi + Podium ----------
    async function computePodium() {
        // 1) Essayer via finale WB + petite finale
        const maxWB = await getActualMaxWinnerRound(tournamentId);
        let gold: string | null | undefined = null;
        let silver: string | null | undefined = null;
        let bronze: string | null | undefined = null;
        let fourth: string | null | undefined = null;
        let note = '';

        if (maxWB > 0) {
            const finals = await fetchRound(tournamentId, 'winner', maxWB);
            if (finals.length >= 1) {
                const f = finals[0];
                if (f.status === 'done' && f.winner) {
                    gold = f.winner;
                    const opp = f.winner === f.player1 ? f.player2 : f.player1;
                    silver = opp || null;
                }
            }
            const { data: lb3 } = await supabase
                .from('matches')
                .select('*')
                .eq('tournament_id', tournamentId)
                .eq('bracket_type', 'loser')
                .eq('round', 3)
                .eq('slot', 1)
                .limit(1);
            const lb = lb3?.[0] as M | undefined;
            if (lb && lb.status === 'done' && lb.winner) {
                bronze = lb.winner;
                const opp = lb.winner === lb.player1 ? lb.player2 : lb.player1;
                fourth = opp || null;
            }
        }

        // 2) Fallback poule : classement par nb de victoires
        if (!gold) {
            note = 'Classement calculé par nombre total de victoires (format poule).';
            const { data: all } = await supabase
                .from('matches')
                .select('winner,status,tournament_id')
                .eq('tournament_id', tournamentId);

            const rows: MinimalMatchRow[] = (all || []) as MinimalMatchRow[];

            const wins = new Map<string, number>();
            rows.forEach((mm) => {
                if (mm.status === 'done' && mm.winner) {
                    wins.set(mm.winner, (wins.get(mm.winner) || 0) + 1);
                }
            });

            const ordered = [...wins.entries()].sort((a, b) => b[1] - a[1]);
            gold = ordered[0]?.[0] ?? null;
            silver = ordered[1]?.[0] ?? null;
            bronze = ordered[2]?.[0] ?? null;
        }

        setPodium({ gold, silver, bronze, fourth, note });
    }

    async function finishTournament() {
        // si des sélections en attente, on te propose d'abord de confirmer
        if (pendingCount > 0) {
            await confirmPending();
        }
        await computePodium();
    }

    // =========================================
    // ================= UI ====================
    // =========================================
    return (
        <div style={{ display: 'grid', gap: 12 }}>
            {/* Podium */}
            {podium && (
                <div
                    style={{
                        background: '#0b1220',
                        border: '1px solid #334155',
                        padding: 12,
                        borderRadius: 10,
                        display: 'grid',
                        gap: 6,
                    }}
                >
                    <div style={{ fontWeight: 700 }}>🏁 Tournoi terminé — Podium</div>
                    <div>🥇 1er : <b>{label(podium.gold ?? null)}</b></div>
                    <div>🥈 2e : <b>{label(podium.silver ?? null)}</b></div>
                    <div>🥉 3e : <b>{label(podium.bronze ?? null)}</b></div>
                    {podium.fourth && <div>4e : <b>{label(podium.fourth)}</b></div>}
                    {podium.note && <div style={{ opacity: 0.8, fontSize: 12 }}>{podium.note}</div>}
                </div>
            )}

            {/* Bandeau top */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {tournamentCode && (
                    <div
                        style={{
                            flex: 1,
                            background: '#1f2937',
                            color: 'white',
                            padding: '8px 12px',
                            textAlign: 'center',
                            borderRadius: 8,
                        }}
                    >
                        Code du tournoi : <b>{tournamentCode}</b>{' '}
                        <button onClick={() => navigator.clipboard.writeText(tournamentCode)} style={{ marginLeft: 8 }}>
                            Copier
                        </button>
                    </div>
                )}
                {canEdit && (
                    <button onClick={() => safeAction(finishTournament)} style={{ padding: '8px 12px', borderRadius: 8 }}>
                        Finir le tournoi
                    </button>
                )}
            </div>

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
                                            {canEdit && m.player1 && m.status !== 'done' && !podium && (
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
                                            {canEdit && m.player2 && m.status !== 'done' && !podium && (
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
                                        {canEdit && !podium && (
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
