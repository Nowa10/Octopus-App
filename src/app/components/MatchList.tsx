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
    format?: 'pool' | 'bracket' | null; // utilisé pour l’UI
};

/* ============================
   Utils purs
   ============================ */
function isPowerOfTwo(n: number) { return n > 0 && (n & (n - 1)) === 0; }
function nextPowerOfTwo(n: number) { let p = 1; while (p < n) p <<= 1; return p; }

// Round-robin canonique (méthode du cercle)
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
        rest.unshift(rest.pop() as string | null); // dernier -> devant
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

// Ta liste “autorisée” pour les brackets manuels
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

    // Mode d’affichage courant
    const [uiMode, setUiMode] = useState<'none' | 'pool' | 'bracket'>('none');

    // Bracket tabs
    const [activeBracket, setActiveBracket] = useState<'winner' | 'loser'>('winner');

    // Pools tabs UI
    const [poolTabs, setPoolTabs] = useState<{
        labels: string[];
        idsByPool: string[][];
        roundsByPool: number[][];
    }>({ labels: [], idsByPool: [], roundsByPool: [] });
    const [activePoolTab, setActivePoolTab] = useState<string | null>(null);

    // sélection groupée des gagnants
    const [pending, setPending] = useState<Record<string, string>>({});
    const pendingCount = Object.keys(pending).length;

    // mémorise K utilisé la dernière fois (utile après reload)
    const [lastPoolsK, setLastPoolsK] = useState<number | null>(null);

    /* ============================
       I/O
       ============================ */
    const load = useCallback(async () => {
        const { data: m } = await supabase
            .from('matches').select('*')
            .eq('tournament_id', tournamentId)
            .order('round').order('slot');
        const ms = (m ?? []) as unknown as M[];
        setMatches(ms);

        const { data: ps } = await supabase
            .from('profiles').select('id,first_name,last_name,wins');
        const map: Record<string, P> = {};
        (ps ?? []).forEach((p) => { const pp = p as unknown as P; map[pp.id] = pp; });
        setPeople(map);

        const { data: t } = await supabase
            .from('tournaments').select('code,format').eq('id', tournamentId).single();
        const val = t && typeof (t as { format?: string }).format === 'string'
            ? (t as { format?: string }).format
            : null;
        const format: TournamentMeta['format'] = val === 'pool' || val === 'bracket' ? val : null;
        setTournament({ code: (t as { code?: string })?.code || '', format });

        // déduit uiMode simple : si format est défini on s’y tient
        if (format === 'bracket') setUiMode('bracket');
        else if (format === 'pool') setUiMode('pool');
        else setUiMode('none');
    }, [tournamentId]);

    useEffect(() => { void load(); }, [load]);

    // Récupère le roster du tournoi
    async function getRoster(): Promise<string[]> {
        // 1) table tournoi_participants si dispo
        const { data: r1 } = await supabase
            .from('tournament_participants')
            .select('profile_id')
            .eq('tournament_id', tournamentId);
        const ids1 = (r1 ?? []).map((r) => (r as { profile_id: string }).profile_id);
        if (ids1.length > 0) return ids1;

        // 2) fallback via matches existants
        const { data: r2 } = await supabase
            .from('matches').select('player1,player2').eq('tournament_id', tournamentId);
        type Row = { player1: string | null; player2: string | null };
        const set = new Set<string>();
        (r2 as Row[] | null)?.forEach((m) => { if (m.player1) set.add(m.player1); if (m.player2) set.add(m.player2); });
        return [...set];
    }

    async function ensureMatch(round: number, slot: number, bracket: 'winner' | 'loser') {
        const { data: existing } = await supabase
            .from('matches').select('*')
            .eq('tournament_id', tournamentId)
            .eq('bracket_type', bracket)
            .eq('round', round)
            .eq('slot', slot)
            .limit(1);
        if (existing && existing[0]) return existing[0] as unknown as M;

        const { data } = await supabase
            .from('matches')
            .insert({
                tournament_id: tournamentId, bracket_type: bracket,
                round, slot, status: 'pending',
                player1: null, player2: null, winner: null,
            })
            .select('*').single();
        return data as unknown as M;
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
                return;
            }

            // reset
            await clearAllMatches();

            // serpentin + rounds
            const pools = serpentineSplit(roster, K);
            const roundsByPool: number[][] = pools.map(() => []);
            let nextRound = 1;

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
                    roundsByPool[p].push(nextRound);
                    nextRound++;
                }
            }

            // Mémorise K pour l’onglet + persiste format
            setLastPoolsK(K);
            setPoolTabs({
                labels: pools.map((_, i) => `Pool ${i + 1}`).concat('Playoffs'),
                idsByPool: pools,
                roundsByPool,
            });
            setActivePoolTab('Pool 1');
            setUiMode('pool');
            await supabase.from('tournaments').update({ format: 'pool' }).eq('id', tournamentId);

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
                return;
            }

            // reset
            await clearAllMatches();

            // Seeding canonique sur U = power of two >= n
            const size = nextPowerOfTwo(n);
            const pairs: Array<[string | null, string | null]> = [];
            for (let i = 0; i < size / 2; i++) {
                const a = i + 1, b = size - i;
                const s1 = roster[a - 1] ?? null;
                const s2 = roster[b - 1] ?? null;
                pairs.push([s1, s2]);
            }

            // Round 1 exact
            let slot = 1;
            for (const [p1, p2] of pairs) {
                await setPlayers(1, slot, p1, p2, 'winner');
                // Auto-qualif si BYE
                if (p1 && !p2) {
                    await supabase.from('matches').update({ winner: p1, status: 'done' })
                        .eq('tournament_id', tournamentId).eq('bracket_type', 'winner').eq('round', 1).eq('slot', slot);
                } else if (!p1 && p2) {
                    await supabase.from('matches').update({ winner: p2, status: 'done' })
                        .eq('tournament_id', tournamentId).eq('bracket_type', 'winner').eq('round', 1).eq('slot', slot);
                }
                slot++;
            }

            // Structure des tours suivants (juste ce qu’il faut)
            let rSize = size / 2;
            let r = 2;
            while (rSize >= 1) {
                for (let s = 1; s <= rSize; s++) {
                    await ensureMatch(r, s, 'winner');
                }
                r++;
                rSize = rSize / 2;
            }

            // Bracket mode + persiste format
            setUiMode('bracket');
            await supabase.from('tournaments').update({ format: 'bracket' }).eq('id', tournamentId);

            await load();
            setInfo('Bracket générée.');
        } finally { setIsBuilding(false); }
    }

    /* ============================
       Loser Bracket simple par “vague”
       ============================ */
    async function ensureConsolationForRound(wbRound: number) {
        // vérifie si le round WB est entièrement terminé
        const { data: wbs } = await supabase
            .from('matches').select('*')
            .eq('tournament_id', tournamentId)
            .eq('bracket_type', 'winner')
            .eq('round', wbRound)
            .order('slot', { ascending: true });

        const wbMatches = (wbs ?? []) as unknown as M[];
        if (wbMatches.length === 0) return;
        if (wbMatches.some((m) => m.status !== 'done')) return;

        // collecte des perdants (dans l’ordre des slots) et appairements
        const losers: string[] = [];
        wbMatches.forEach((m) => {
            const l = m.winner === m.player1 ? m.player2 : m.player1;
            if (l) losers.push(l);
        });
        if (losers.length < 2) return;

        let slot = 1;
        for (let i = 0; i + 1 < losers.length; i += 2) {
            await setPlayers(wbRound, slot++, losers[i], losers[i + 1], 'loser');
        }
    }

    /* ============================
       Propagation KO direct (WB)
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

        if (uiMode !== 'bracket') return; // pas de propagation spéciale en pools

        if (m.bracket_type === 'winner') {
            // Propagation vers le prochain tour WB
            const nextRound = m.round + 1;
            const nextSlot = Math.ceil(m.slot / 2);
            const prefer: 'player1' | 'player2' = m.slot % 2 === 1 ? 'player1' : 'player2';
            await setPlayerOnMatch(nextRound, nextSlot, winnerId, prefer);

            // Crée la “vague” de loser une fois tout le round WB terminé
            await ensureConsolationForRound(m.round);
        }
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
            // ordre cohérent (WB avant LB, petit round -> grand)
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
       Labels & vues
       ============================ */
    const label = (id: string | null) =>
        id ? `${people[id]?.first_name || '?'} ${people[id]?.last_name || ''}` : 'BYE';

    // Filtres d’affichage
    const filteredWinnerMatches = useMemo(() => matches.filter((m) => m.bracket_type === 'winner'), [matches]);
    const filteredLoserMatches = useMemo(() => matches.filter((m) => m.bracket_type === 'loser'), [matches]);

    // En mode POOL, on filtre par onglet
    const poolMatchesForUI = useMemo(() => {
        if (uiMode !== 'pool') return filteredWinnerMatches;
        if (!activePoolTab || poolTabs.labels.length === 0) return filteredWinnerMatches;

        if (activePoolTab === 'Playoffs') {
            // Placeholder : pas de génération pour l’instant
            return [] as M[];
        }

        const idx = poolTabs.labels.indexOf(activePoolTab);
        if (idx === -1) return filteredWinnerMatches;

        const idsSet = new Set(poolTabs.idsByPool[idx] || []);
        const roundsSet = new Set(poolTabs.roundsByPool[idx] || []);
        return filteredWinnerMatches.filter(
            (m) =>
                m.player1 && m.player2 &&
                idsSet.has(m.player1) && idsSet.has(m.player2) &&
                roundsSet.has(m.round)
        );
    }, [uiMode, filteredWinnerMatches, activePoolTab, poolTabs]);

    // Rounds
    const roundsWB = useMemo(() => {
        const src = uiMode === 'pool' ? poolMatchesForUI : filteredWinnerMatches;
        const byRound = new Map<number, M[]>();
        for (const m of src) {
            if (!byRound.has(m.round)) byRound.set(m.round, []);
            byRound.get(m.round)!.push(m);
        }
        for (const r of byRound.keys()) byRound.get(r)!.sort((a, b) => a.slot - b.slot);
        return [...byRound.entries()].sort((a, b) => a[0] - b[0]);
    }, [uiMode, poolMatchesForUI, filteredWinnerMatches]);

    const roundsLB = useMemo(() => {
        const byRound = new Map<number, M[]>();
        for (const m of filteredLoserMatches) {
            if (!byRound.has(m.round)) byRound.set(m.round, []);
            byRound.get(m.round)!.push(m);
        }
        for (const r of byRound.keys()) byRound.get(r)!.sort((a, b) => a.slot - b.slot);
        return [...byRound.entries()].sort((a, b) => a[0] - b[0]);
    }, [filteredLoserMatches]);

    /* ============================
       UI
       ============================ */
    const tournamentCode = tournament?.code || null;

    return (
        <div className="container stack">
            {/* Barre d’actions MANUELLES */}
            <div className="card">
                <div className="card__content hstack" style={{ gap: 8, flexWrap: 'wrap' }}>
                    {tournamentCode && <span>Code: <b>{tournamentCode}</b></span>}
                    <span className="spacer" />
                    {canEdit && (
                        <>
                            <Button
                                variant="ghost"
                                onClick={() => {
                                    setIsBuilding(true);
                                    clearAllMatches().then(() => {
                                        setUiMode('none');
                                        setPoolTabs({ labels: [], idsByPool: [], roundsByPool: [] });
                                        setActivePoolTab(null);
                                    }).then(load).finally(() => setIsBuilding(false));
                                }}
                            >
                                Vider les matchs
                            </Button>

                            <Button variant="primary" onClick={() => generateBracketFromRoster()}>
                                Générer une bracket
                            </Button>

                            <Button variant="ghost" onClick={() => generatePools(2)}>Générer 2 poules</Button>
                            <Button variant="ghost" onClick={() => generatePools(3)}>Générer 3 poules</Button>
                            <Button variant="ghost" onClick={() => generatePools(4)}>Générer 4 poules</Button>
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

            {/* Onglets haut : Pools OU Brackets */}
            {uiMode === 'bracket' && (
                <Segment
                    value={activeBracket}
                    onChange={(v) => setActiveBracket(v as 'winner' | 'loser')}
                    items={[
                        { label: 'Winner Bracket', value: 'winner' },
                        { label: 'Loser Bracket', value: 'loser' },
                    ]}
                />
            )}

            {uiMode === 'pool' && poolTabs.labels.length > 0 && (
                <Segment
                    value={activePoolTab || poolTabs.labels[0]}
                    onChange={(v) => setActivePoolTab(v as string)}
                    items={poolTabs.labels.map((L) => ({ label: L, value: L }))}
                />
            )}

            {/* Grille des rounds */}
            <div className="rounds">
                {/* Winner side (ou Pools) */}
                {((uiMode === 'pool' && (activePoolTab ?? '')) !== 'Playoffs') && roundsWB.map(([roundIdx, items]) => (
                    <div key={`wb-${roundIdx}`} className="stack">
                        <div className="round-title">
                            {uiMode === 'pool' ? `Round ${roundIdx} — ${activePoolTab}` : `Round ${roundIdx}`}
                        </div>

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

                {/* Placeholder Playoffs en mode POOL */}
                {uiMode === 'pool' && (activePoolTab === 'Playoffs') && (
                    <div className="card">
                        <div className="card__content">
                            <b>Playoffs</b> — (désactivé pour l’instant). Tu pourras plus tard générer un bracket Top-2/Top-X ici.
                        </div>
                    </div>
                )}

                {/* Loser side (seulement en mode bracket) */}
                {uiMode === 'bracket' && activeBracket === 'loser' && roundsLB.map(([roundIdx, items]) => (
                    <div key={`lb-${roundIdx}`} className="stack">
                        <div className="round-title">Loser Round {roundIdx}</div>

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

                {/* Rien à afficher */}
                {roundsWB.length === 0 && !(uiMode === 'pool' && activePoolTab === 'Playoffs') && !isBuilding && (
                    <div style={{ opacity: 0.7 }}>Aucun match à afficher.</div>
                )}
            </div>
        </div>
    );
}
