'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Button, Segment } from '@/app/components/ui';

/* ============================
   Types
   ============================ */
type P = {
    id: string;
    first_name: string;
    last_name: string | null;
    wins?: number | null;
};

type M = {
    id: string;
    tournament_id: string;
    round: number; // 1..K
    slot: number;  // 1..S
    bracket_type: 'winner' | 'loser';
    status: 'pending' | 'done' | 'canceled';
    player1: string | null;
    player2: string | null;
    winner: string | null;
};

type TournamentMeta = {
    code: string;
    format?: 'pool' | 'bracket' | null; // ignoré pour le mode manuel, mais on l’affiche
};

/* ============================
   Utils purs
   ============================ */
function isPowerOfTwo(n: number) { return n > 0 && (n & (n - 1)) === 0; }
function nextPowerOfTwo(n: number) { let p = 1; while (p < n) p <<= 1; return p; }

function rrPairsAllRounds(ids: (string | null)[]) {
    const n = ids.length;
    const total = n - 1;
    const rounds: Array<Array<[string | null, string | null]>> = [];
    let arr = ids.slice();
    for (let r = 0; r < total; r++) {
        const pairs: Array<[string | null, string | null]> = [];
        for (let i = 0; i < n / 2; i++) pairs.push([arr[i], arr[n - 1 - i]]);
        rounds.push(pairs);
        const fixed = arr[0];
        const rest = arr.slice(1);
        rest.unshift(rest.pop() as string | null);
        arr = [fixed, ...rest];
    }
    return rounds;
}

function serpentineSplit(ids: string[], K: number) {
    const pools: string[][] = Array.from({ length: K }, () => []);
    let i = 0, dir = 1;
    for (const id of ids) {
        pools[i].push(id);
        i += dir;
        if (i === K) { dir = -1; i = K - 1; }
        if (i < 0) { dir = 1; i = 0; }
    }
    return pools;
}

// règles d’autorisation Bracket (manuel)
function bracketAllowed(n: number) {
    if (n === 4) return true;
    if (n >= 7 && n <= 8) return true;
    if (n >= 11 && n <= 12) return true;
    if (n >= 15 && n <= 16) return true;
    if (n === 32) return true;
    return false;
}

/* ============================
   Composant (MANUEL)
   ============================ */
export default function MatchList({
    tournamentId,
    canEdit,
}: { tournamentId: string; canEdit: boolean }) {
    const [isBuilding, setIsBuilding] = useState(false);
    const [info, setInfo] = useState<string | null>(null);

    const [matches, setMatches] = useState<M[]>([]);
    const [people, setPeople] = useState<Record<string, P>>({});
    const [tournament, setTournament] = useState<TournamentMeta | null>(null);
    const [activeBracket, setActiveBracket] = useState<'winner' | 'loser'>('winner');

    // pour affichage BYE cachés en poule
    const label = (id: string | null) =>
        id ? `${people[id]?.first_name || '?'} ${people[id]?.last_name || ''}` : 'BYE';

    // sélection groupée des gagnants
    const [pending, setPending] = useState<Record<string, string>>({});
    const pendingCount = Object.keys(pending).length;

    // mémoire locale du dernier “K” de poules généré (utile pour “générer playoffs”)
    const [lastPoolsK, setLastPoolsK] = useState<number | null>(null);

    /* ============================
       I/O
       ============================ */
    const load = useCallback(async () => {
        const { data: m } = await supabase
            .from('matches').select('*')
            .eq('tournament_id', tournamentId)
            .order('round').order('slot');
        setMatches((m ?? []) as M[]);

        const { data: ps } = await supabase
            .from('profiles').select('id,first_name,last_name,wins');
        const map: Record<string, P> = {};
        (ps ?? []).forEach((p) => { const pp = p as P; map[pp.id] = pp; });
        setPeople(map);

        const { data: t } = await supabase
            .from('tournaments').select('code,format').eq('id', tournamentId).single();
        const val = t && typeof t.format === 'string' ? t.format : null;
        const format: TournamentMeta['format'] = val === 'pool' || val === 'bracket' ? val : null;
        setTournament({ code: t?.code || '', format });
    }, [tournamentId]);

    useEffect(() => { void load(); }, [load]);

    // essaie de récupérer le roster depuis une table “roster”; sinon fallback via matches
    async function getRoster(): Promise<string[]> {
        // 1) tournoi_participants (si tu l’as)
        const { data: r1 } = await supabase
            .from('tournament_participants')
            .select('profile_id')
            .eq('tournament_id', tournamentId);
        const ids1 = (r1 ?? []).map((r) => (r as { profile_id: string }).profile_id);
        if (ids1.length > 0) return ids1;

        // 2) fallback: joueurs rencontrés dans les matches existants
        const { data: r2 } = await supabase
            .from('matches').select('player1,player2').eq('tournament_id', tournamentId);
        type Row = { player1: string | null; player2: string | null };
        const set = new Set<string>();
        (r2 as Row[] | null)?.forEach((m) => { if (m.player1) set.add(m.player1); if (m.player2) set.add(m.player2); });
        return [...set];
    }

    async function getRoundBounds(bracket: 'winner' | 'loser') {
        const { data } = await supabase
            .from('matches').select('round')
            .eq('tournament_id', tournamentId)
            .eq('bracket_type', bracket);
        const arr = (data ?? []).map((x) => x.round as number);
        return { min: arr.length ? Math.min(...arr) : 0, max: arr.length ? Math.max(...arr) : 0 };
    }

    async function ensureMatch(round: number, slot: number, bracket: 'winner' | 'loser') {
        const { data: existing } = await supabase
            .from('matches').select('*')
            .eq('tournament_id', tournamentId)
            .eq('bracket_type', bracket)
            .eq('round', round)
            .eq('slot', slot)
            .limit(1);
        if (existing && existing[0]) return existing[0] as M;

        const { data } = await supabase
            .from('matches')
            .insert({
                tournament_id: tournamentId, bracket_type: bracket,
                round, slot, status: 'pending',
                player1: null, player2: null, winner: null,
            })
            .select('*').single();
        return data as M;
    }

    async function setPlayers(round: number, slot: number, p1: string | null, p2: string | null, bracket: 'winner' | 'loser' = 'winner') {
        const m = await ensureMatch(round, slot, bracket);
        await supabase.from('matches').update({ player1: p1, player2: p2 }).eq('id', m.id);
    }

    async function clearAllMatches() {
        await supabase.from('matches').delete().eq('tournament_id', tournamentId);
    }

    /* ============================
       Génération — POULLES (manuelle)
       ============================ */
    async function generatePools(K: number) {
        setInfo(null);
        setIsBuilding(true);
        try {
            const roster = await getRoster();
            if (roster.length < 3) {
                setInfo('Pas assez de joueurs pour des poules (min 3).');
                setIsBuilding(false);
                return;
            }

            // on repart propre
            await clearAllMatches();

            const pools = serpentineSplit(roster, K);
            const { max } = await getRoundBounds('winner');
            let nextRound = (max || 0) + 1;

            for (let p = 0; p < pools.length; p++) {
                const group = pools[p];
                const seed = group.length % 2 === 0 ? group.slice() : [...group, null];
                const roundsRR = rrPairsAllRounds(seed);
                for (let g = 0; g < roundsRR.length; g++) {
                    let slot = 1;
                    for (const [a, b] of roundsRR[g]) {
                        if (!a || !b) continue; // on ne stocke pas les BYE
                        await setPlayers(nextRound, slot++, a, b, 'winner');
                    }
                    nextRound++;
                }
            }

            setLastPoolsK(K);
            await load();
            setInfo(`Poules générées (${K}).`);
        } finally {
            setIsBuilding(false);
        }
    }

    /* ============================
       Génération — BRACKET (manuelle)
       ============================ */
    async function generateBracketFromRoster() {
        setInfo(null);
        setIsBuilding(true);
        try {
            const roster = await getRoster();
            const n = roster.length;
            if (!bracketAllowed(n)) {
                setInfo(`Taille ${n} refusée pour un bracket manuel. Autorisé: 4, 7–8, 11–12, 15–16, 32.`);
                setIsBuilding(false);
                return;
            }

            // vide tout, puis construit un SE avec BYE si besoin
            await clearAllMatches();

            const size = nextPowerOfTwo(n);
            const pairs: Array<[string | null, string | null]> = [];
            for (let i = 0; i < size / 2; i++) {
                const a = i + 1, b = size - i;
                const s1 = roster[a - 1] ?? null;
                const s2 = roster[b - 1] ?? null;
                pairs.push([s1, s2]);
            }

            // Round 1
            let slot = 1;
            for (const [p1, p2] of pairs) {
                await setPlayers(1, slot, p1, p2, 'winner');
                // auto-victoire si BYE
                if (p1 && !p2) {
                    await supabase.from('matches').update({ winner: p1, status: 'done' })
                        .eq('tournament_id', tournamentId).eq('bracket_type', 'winner').eq('round', 1).eq('slot', slot);
                } else if (!p1 && p2) {
                    await supabase.from('matches').update({ winner: p2, status: 'done' })
                        .eq('tournament_id', tournamentId).eq('bracket_type', 'winner').eq('round', 1).eq('slot', slot);
                }
                slot++;
            }

            // structure des tours suivants
            let rSize = size / 2;
            let r = 2;
            while (rSize >= 1) {
                for (let s = 1; s <= rSize; s++) {
                    await ensureMatch(r, s, 'winner');
                }
                r++;
                rSize = rSize / 2;
            }

            await load();
            setInfo('Bracket générée.');
        } finally { setIsBuilding(false); }
    }

    /* ============================
       Génération — PLAYOFFS (Top-2/poule) manuelle
       ============================ */
    async function generatePlayoffsFromPools() {
        setInfo(null);
        setIsBuilding(true);
        try {
            // déduit K: priorité au dernier K demandé, sinon estimation naive
            let K = lastPoolsK ?? 2;
            const roster = await getRoster();
            if (!lastPoolsK) {
                if (roster.length >= 13) K = 4; else K = 2;
            }

            // reconstruit la même répartition que lors du generatePools(K)
            const pools = serpentineSplit(roster, K);

            // calcule les wins par poule à partir des matches existants
            const winnersByPool: string[][] = [];
            let maxRoundUsed = 0;

            for (const group of pools) {
                const set = new Set(group);
                const { data: all } = await supabase
                    .from('matches').select('*')
                    .eq('tournament_id', tournamentId)
                    .eq('bracket_type', 'winner');

                const inPool = (all ?? []).filter((m) => m.player1 && m.player2 && set.has(m.player1) && set.has(m.player2)) as M[];
                const wins = new Map<string, number>();
                group.forEach((id) => wins.set(id, 0));
                for (const m of inPool) {
                    if (m.status === 'done' && m.winner) wins.set(m.winner, (wins.get(m.winner) || 0) + 1);
                    if (m.round > maxRoundUsed) maxRoundUsed = m.round;
                }
                const order = [...wins.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
                winnersByPool.push(order.slice(0, 2)); // Top-2
            }

            // condition: tous les matchs de poule doivent être “done”
            const { data: allWinner } = await supabase
                .from('matches').select('*')
                .eq('tournament_id', tournamentId)
                .eq('bracket_type', 'winner');
            const pendingInPools = (allWinner ?? []).some((m) => (m as M).player1 && (m as M).player2 && (m as M).status !== 'done' && (m as M).round <= maxRoundUsed);
            if (pendingInPools) {
                setInfo('Il reste des matchs de poule non terminés.');
                setIsBuilding(false);
                return;
            }

            // on place des demi-finales : 1A-2B, 1B-2A (si K=2)
            // si K=3/4 → on prend Top-2 de chaque et on fait un SE à 4/8
            const seeds: string[] = [];
            if (K === 2) {
                const A = winnersByPool[0] ?? [];
                const B = winnersByPool[1] ?? [];
                if (A.length < 2 || B.length < 2) {
                    setInfo('Pas assez de résultats pour faire les demi-finales Top-2.');
                    setIsBuilding(false);
                    return;
                }
                // crée directement demies au round suivant
                const start = maxRoundUsed + 1;
                await setPlayers(start, 1, A[0], B[1], 'winner');
                await setPlayers(start, 2, B[0], A[1], 'winner');
                // finale vide
                await ensureMatch(start + 1, 1, 'winner');
                setInfo('Playoffs (demi-finales + finale) générés.');
            } else {
                winnersByPool.forEach((arr) => seeds.push(...arr));
                const start = maxRoundUsed + 1;
                await buildSEFromSeedsManual(seeds, start);
                setInfo('Playoffs (SE) générés à partir des Top-2.');
            }

            await load();
        } finally {
            setIsBuilding(false);
        }
    }

    // petit builder SE réutilisé par le générateur de playoffs
    async function buildSEFromSeedsManual(seeds: string[], startRound: number) {
        if (seeds.length < 2) return;
        const size = nextPowerOfTwo(seeds.length);
        const pairs: Array<[string | null, string | null]> = [];
        for (let i = 0; i < size / 2; i++) {
            const a = i + 1, b = size - i;
            pairs.push([seeds[a - 1] ?? null, seeds[b - 1] ?? null]);
        }
        let slot = 1;
        for (const [p1, p2] of pairs) {
            await setPlayers(startRound, slot, p1, p2, 'winner');
            if (p1 && !p2) {
                await supabase.from('matches').update({ winner: p1, status: 'done' })
                    .eq('tournament_id', tournamentId).eq('bracket_type', 'winner').eq('round', startRound).eq('slot', slot);
            } else if (!p1 && p2) {
                await supabase.from('matches').update({ winner: p2, status: 'done' })
                    .eq('tournament_id', tournamentId).eq('bracket_type', 'winner').eq('round', startRound).eq('slot', slot);
            }
            slot++;
        }
        // structure suivante
        let rSize = size / 2; let r = startRound + 1;
        while (rSize >= 1) {
            for (let s = 1; s <= rSize; s++) await ensureMatch(r, s, 'winner');
            r++; rSize = rSize / 2;
        }
    }

    /* ============================
       Propagation des vainqueurs (KO direct)
       ============================ */
    async function setPlayerOnMatch(round: number, slot: number, playerId: string, prefer: 'player1' | 'player2') {
        const m = await ensureMatch(round, slot, 'winner');
        const patch: Partial<M> = {};
        if (prefer === 'player1' && !m.player1) patch.player1 = playerId;
        if (prefer === 'player2' && !m.player2) patch.player2 = playerId;
        if (Object.keys(patch).length) await supabase.from('matches').update(patch).eq('id', m.id);
    }

    async function applyWinner(m: M, winnerId: string) {
        await supabase.from('matches').update({ winner: winnerId, status: 'done' }).eq('id', m.id);

        // seulement propagation dans le bracket winner
        if (m.bracket_type !== 'winner') return;

        // place le vainqueur dans le match suivant (KO direct)
        const nextRound = m.round + 1;
        const nextSlot = Math.ceil(m.slot / 2);
        const prefer: 'player1' | 'player2' = m.slot % 2 === 1 ? 'player1' : 'player2';
        await setPlayerOnMatch(nextRound, nextSlot, winnerId, prefer);
    }

    /* ============================
       Validation groupée / reset
       ============================ */
    function selectWinner(m: M, winnerId: string) {
        if (m.status === 'done') return;
        setPending((prev) => ({ ...prev, [m.id]: winnerId }));
    }
    function clearPending() { setPending({}); }

    async function confirmPending() {
        if (pendingCount === 0) return;
        setIsBuilding(true);
        try {
            const items: { m: M; winnerId: string }[] = [];
            for (const [id, w] of Object.entries(pending)) {
                const m = matches.find((x) => x.id === id);
                if (m && w) items.push({ m, winnerId: w });
            }
            // ordre cohérent
            items.sort((a, b) => {
                if (a.m.bracket_type !== b.m.bracket_type) return a.m.bracket_type === 'winner' ? -1 : 1;
                if (a.m.round !== b.m.round) return a.m.round - b.m.round;
                return a.m.slot - b.m.slot;
            });

            for (const it of items) await applyWinner(it.m, it.winnerId);

            setPending({});
            await load();
        } finally { setIsBuilding(false); }
    }

    async function resetMatch(m: M) {
        setIsBuilding(true);
        try {
            await supabase.from('matches').update({ winner: null, status: 'pending' }).eq('id', m.id);
            await load();
        } finally { setIsBuilding(false); }
    }

    /* ============================
       Vue / données
       ============================ */
    const tournamentCode = tournament?.code || null;

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
        for (const r of byRound.keys()) byRound.get(r)!.sort((a, b) => a.slot - b.slot);
        return [...byRound.entries()].sort((a, b) => a[0] - b[0]);
    }, [bracketMatches]);

    /* ============================
       UI
       ============================ */
    return (
        <div className="container stack">
            {/* Barre d’actions MANUELLES */}
            <div className="card">
                <div className="card__content hstack" style={{ gap: 8, flexWrap: 'wrap' }}>
                    {tournamentCode && <span>Code: <b>{tournamentCode}</b></span>}
                    <span className="spacer" />
                    {canEdit && (
                        <>
                            <Button variant="ghost" onClick={() => { setIsBuilding(true); clearAllMatches().then(() => load()).finally(() => setIsBuilding(false)); }}>
                                Vider les matchs
                            </Button>
                            <Button variant="primary" onClick={() => generateBracketFromRoster()}>
                                Générer une bracket
                            </Button>
                            <Button variant="ghost" onClick={() => generatePools(2)}>Générer 2 poules</Button>
                            <Button variant="ghost" onClick={() => generatePools(3)}>Générer 3 poules</Button>
                            <Button variant="ghost" onClick={() => generatePools(4)}>Générer 4 poules</Button>
                            <Button variant="ghost" onClick={() => generatePlayoffsFromPools()}>
                                Générer les playoffs (Top-2)
                            </Button>
                        </>
                    )}
                </div>
            </div>

            {/* Info & loader */}
            {info && (
                <div className="card">
                    <div className="card__content" style={{ color: '#8a1c1c' }}>{info}</div>
                </div>
            )}
            {isBuilding && (
                <div className="card">
                    <div className="card__content" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div className="spinner" /> génération / mise à jour en cours…
                    </div>
                </div>
            )}

            {/* Validation groupée */}
            {canEdit && pendingCount > 0 && (
                <div className="toolbar hstack">
                    <span className="badge">✅ {pendingCount} victoire(s) en attente</span>
                    <span className="spacer" />
                    <Button variant="primary" onClick={() => confirmPending()}>Confirmer</Button>
                    <Button variant="ghost" onClick={() => clearPending()}>Annuler</Button>
                </div>
            )}

            {/* Winner / Loser tabs */}
            <Segment
                value={activeBracket}
                onChange={(v) => setActiveBracket(v as 'winner' | 'loser')}
                items={[
                    { label: 'Winner Bracket', value: 'winner' },
                    { label: 'Loser Bracket', value: 'loser' },
                ]}
            />

            {/* Matches */}
            <div className="rounds">
                {rounds.length === 0 && !isBuilding && <div style={{ opacity: 0.7 }}>Aucun match à afficher.</div>}

                {rounds.map(([roundIdx, items]) => (
                    <div key={roundIdx} className="stack">
                        <div className="round-title">Round {roundIdx}</div>

                        {items.map((m) => {
                            const pendingWinner = pending[m.id];
                            const isSelectedP1 = !!pendingWinner && pendingWinner === m.player1;
                            const isSelectedP2 = !!pendingWinner && pendingWinner === m.player2;

                            return (
                                <div key={m.id} className="card">
                                    <div className="card__content stack">
                                        <div className="hstack">
                                            <div style={{ fontWeight: 700 }}>Match {m.slot}</div>
                                            <span className="spacer" />
                                            {m.status === 'done'
                                                ? <span className="badge">Vainqueur : <b>{label(m.winner)}</b></span>
                                                : pendingWinner
                                                    ? <span style={{ opacity: 0.9 }}>Sélectionné : {label(pendingWinner)}</span>
                                                    : <span style={{ opacity: 0.6 }}>—</span>
                                            }
                                        </div>

                                        <div className="stack">
                                            <div className={`matchline ${m.status === 'done' && m.winner === m.player1 ? 'is-winner' : ''} ${isSelectedP1 ? 'is-pending' : ''}`}>
                                                <span>{label(m.player1)}</span>
                                                {canEdit && m.player1 && m.status !== 'done' && (
                                                    <Button size="sm" variant="ghost" onClick={() => selectWinner(m, m.player1 as string)}>Gagnant</Button>
                                                )}
                                            </div>

                                            <div className={`matchline ${m.status === 'done' && m.winner === m.player2 ? 'is-winner' : ''} ${isSelectedP2 ? 'is-pending' : ''}`}>
                                                <span>{label(m.player2)}</span>
                                                {canEdit && m.player2 && m.status !== 'done' && (
                                                    <Button size="sm" variant="ghost" onClick={() => selectWinner(m, m.player2 as string)}>Gagnant</Button>
                                                )}
                                            </div>
                                        </div>

                                        {canEdit && (
                                            <div className="hstack" style={{ marginTop: 8 }}>
                                                <span className="spacer" />
                                                <Button size="sm" variant="danger" onClick={() => resetMatch(m)}>Réinitialiser</Button>
                                            </div>
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
