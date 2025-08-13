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
    round: number;      // 1..K
    slot: number;       // 1..S
    bracket_type: 'winner' | 'loser';
    status: 'pending' | 'done' | 'canceled';
    player1: string | null;
    player2: string | null;
    winner: string | null;
};

/* ============================
   Utils
   ============================ */
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

// liste autorisée pour générer un bracket directement
function bracketAllowed(n: number) {
    if (n === 4) return true;
    if (n >= 7 && n <= 8) return true;
    if (n >= 11 && n <= 12) return true;
    if (n >= 15 && n <= 16) return true;
    if (n === 32) return true;
    return false;
}

/* ============================
   Composant
   ============================ */
export default function MatchList({
    tournamentId,
    canEdit,
}: { tournamentId: string; canEdit: boolean }) {
    const [isBuilding, setIsBuilding] = useState(false);
    const [info, setInfo] = useState<string | null>(null);

    const [matches, setMatches] = useState<M[]>([]);
    const [people, setPeople] = useState<Record<string, P>>({});

    // Mode UI local (aucune dépendance à "tournaments")
    const [uiMode, setUiMode] = useState<'none' | 'pool' | 'bracket'>('none');

    // Onglets Bracket
    const [activeBracket, setActiveBracket] = useState<'winner' | 'loser'>('winner');

    // Onglets Pools
    const [poolTabs, setPoolTabs] = useState<{
        labels: string[];
        idsByPool: string[][];
        roundsByPool: number[][];
    }>({ labels: [], idsByPool: [], roundsByPool: [] });
    const [activePoolTab, setActivePoolTab] = useState<string | null>(null);

    // Sélection groupée de gagnants
    const [pending, setPending] = useState<Record<string, string>>({});
    const pendingCount = Object.keys(pending).length;

    // Sélection des participants (nouveau)
    const [rosterIds, setRosterIds] = useState<string[]>([]);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

    /* ============================
       I/O
       ============================ */
    const load = useCallback(async () => {
        // matches
        const { data: m } = await supabase
            .from('matches').select('*')
            .eq('tournament_id', tournamentId)
            .order('round').order('slot');
        setMatches(((m ?? []) as unknown) as M[]);

        // profiles
        const { data: ps } = await supabase
            .from('profiles').select('id,first_name,last_name,wins');
        const map: Record<string, P> = {};
        (ps ?? []).forEach((p) => { const pp = (p as unknown) as P; map[pp.id] = pp; });
        setPeople(map);
    }, [tournamentId]);

    useEffect(() => { void load(); }, [load]);

    async function getRoster(): Promise<string[]> {
        // 1) participants (si table dispo)
        const { data: r1, error: e1 } = await supabase
            .from('tournament_participants')
            .select('profile_id')
            .eq('tournament_id', tournamentId);
        if (!e1) {
            const ids1 = (r1 ?? []).map((r) => (r as { profile_id: string }).profile_id);
            if (ids1.length > 0) return ids1;
        }
        // 2) fallback via matches
        const { data: r2 } = await supabase
            .from('matches').select('player1,player2').eq('tournament_id', tournamentId);
        type Row = { player1: string | null; player2: string | null };
        const set = new Set<string>();
        (r2 as Row[] | null)?.forEach((m) => { if (m.player1) set.add(m.player1); if (m.player2) set.add(m.player2); });
        return [...set];
    }

    // charge roster + init sélection
    useEffect(() => {
        (async () => {
            const ids = await getRoster();
            setRosterIds(ids);
            setSelectedIds(new Set(ids)); // par défaut: tout coché
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tournamentId]);

    async function fetchRound(bracket: 'winner' | 'loser', round: number): Promise<M[]> {
        const { data } = await supabase
            .from('matches').select('*')
            .eq('tournament_id', tournamentId)
            .eq('bracket_type', bracket)
            .eq('round', round)
            .order('slot', { ascending: true });
        return ((data ?? []) as unknown) as M[];
    }

    async function getWBMaxRound(): Promise<number> {
        const { data } = await supabase
            .from('matches').select('round')
            .eq('tournament_id', tournamentId)
            .eq('bracket_type', 'winner');
        const arr = (data ?? []).map((x) => (x as { round: number }).round);
        return arr.length ? Math.max(...arr) : 0;
    }

    async function ensureMatch(round: number, slot: number, bracket: 'winner' | 'loser') {
        const { data: existing } = await supabase
            .from('matches').select('*')
            .eq('tournament_id', tournamentId)
            .eq('bracket_type', bracket)
            .eq('round', round)
            .eq('slot', slot)
            .limit(1);
        if (existing && existing[0]) return (existing[0] as unknown) as M;

        const { data } = await supabase
            .from('matches')
            .insert({
                tournament_id: tournamentId, bracket_type: bracket,
                round, slot, status: 'pending',
                player1: null, player2: null, winner: null,
            })
            .select('*').single();
        return (data as unknown) as M;
    }

    async function setPlayers(
        round: number, slot: number,
        p1: string | null, p2: string | null,
        bracket: 'winner' | 'loser' = 'winner'
    ) {
        const m = await ensureMatch(round, slot, bracket);
        await supabase.from('matches').update({ player1: p1, player2: p2 }).eq('id', m.id);
    }

    async function clearAllMatches() {
        await supabase.from('matches').delete().eq('tournament_id', tournamentId);
    }

    /* ============================
       Génération — POOLS
       ============================ */
    async function generatePools(K: number) {
        setInfo(null);
        setIsBuilding(true);
        try {
            const roster = await getRoster();
            if (roster.length < 3) { setInfo('Pas assez de joueurs pour des poules (min 3).'); return; }

            await clearAllMatches();

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
                        if (!a || !b) continue; // pas de BYE en DB
                        await setPlayers(nextRound, slot++, a, b, 'winner');
                    }
                    roundsByPool[p].push(nextRound);
                    nextRound++;
                }
            }

            setPoolTabs({
                labels: pools.map((_, i) => `Pool ${i + 1}`).concat('Playoffs'),
                idsByPool: pools,
                roundsByPool,
            });
            setActivePoolTab('Pool 1');
            setUiMode('pool');

            await load();
            setInfo(`Poules générées (${K}).`);
        } finally { setIsBuilding(false); }
    }

    /* ============================
       Génération — BRACKET (R1 uniquement)
       ============================ */
    async function generateBracketFromList(list: string[]) {
        const n = list.length;
        if (!bracketAllowed(n)) {
            setInfo(`La taille ${n} n’est pas autorisée pour un bracket direct. (Autorisé: 4, 7–8, 11–12, 15–16, 32).`);
            return;
        }

        await clearAllMatches();

        const size = nextPowerOfTwo(n);
        const pairs: Array<[string | null, string | null]> = [];
        for (let i = 0; i < size / 2; i++) {
            const a = i + 1, b = size - i;
            pairs.push([list[a - 1] ?? null, list[b - 1] ?? null]);
        }

        let slot = 1;
        for (const [p1, p2] of pairs) {
            await setPlayers(1, slot, p1, p2, 'winner');
            // auto-win si BYE
            if (p1 && !p2) {
                await supabase.from('matches').update({ winner: p1, status: 'done' })
                    .eq('tournament_id', tournamentId).eq('bracket_type', 'winner').eq('round', 1).eq('slot', slot);
            } else if (!p1 && p2) {
                await supabase.from('matches').update({ winner: p2, status: 'done' })
                    .eq('tournament_id', tournamentId).eq('bracket_type', 'winner').eq('round', 1).eq('slot', slot);
            }
            slot++;
        }

        setUiMode('bracket');
        await load();
        setInfo('Bracket (Round 1) générée. Valide les gagnants pour créer le round suivant.');
    }

    async function generateBracketFromRoster() {
        setInfo(null);
        setIsBuilding(true);
        try {
            const roster = await getRoster();
            await generateBracketFromList(roster);
        } finally { setIsBuilding(false); }
    }

    async function generateBracketFromSelection() {
        setInfo(null);
        setIsBuilding(true);
        try {
            const list = Array.from(selectedIds);
            if (list.length < 2) { setInfo('Sélection insuffisante (min 2).'); return; }
            await generateBracketFromList(list);
        } finally { setIsBuilding(false); }
    }

    /* ============================
       Loser Bracket (vague par round WB terminé)
       ============================ */
    async function ensureConsolationForRound(wbRound: number) {
        const wbs = await fetchRound('winner', wbRound);
        if (wbs.length === 0) return;
        if (wbs.some((m) => m.status !== 'done')) return;

        const losers: string[] = [];
        wbs.forEach((m) => {
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
       Avancement WB: crée le prochain round si le courant est fini
       ============================ */
    async function advanceWBIfReady() {
        const max = await getWBMaxRound();
        if (max === 0) return;

        const current = await fetchRound('winner', max);
        // finale finie => rien
        if (current.length === 1 && current[0].status === 'done') return;

        // si pas tout "done", on attend
        if (current.some((m) => m.status !== 'done')) return;

        // si le round suivant existe déjà, on sort
        const next = await fetchRound('winner', max + 1);
        if (next.length > 0) return;

        // crée le round suivant à partir des vainqueurs
        let slot = 1;
        for (let i = 0; i + 1 < current.length; i += 2) {
            const w1 = current[i].winner ?? null;
            const w2 = current[i + 1].winner ?? null;
            await setPlayers(max + 1, slot++, w1, w2, 'winner');
        }
    }

    /* ============================
       Sélection / Validation / Reset
       ============================ */
    const nameOf = (id: string | null) =>
        id ? `${people[id]?.first_name || '?'} ${people[id]?.last_name || ''}` : 'BYE';

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
            // Winner d'abord, round croissant, puis slot
            items.sort((a, b) => {
                if (a.m.bracket_type !== b.m.bracket_type) return a.m.bracket_type === 'winner' ? -1 : 1;
                if (a.m.round !== b.m.round) return a.m.round - b.m.round;
                return a.m.slot - b.m.slot;
            });

            for (const it of items) {
                await supabase.from('matches').update({ winner: it.winnerId, status: 'done' }).eq('id', it.m.id);
            }

            if (uiMode === 'bracket') {
                const touchedWB = new Set(items.filter(i => i.m.bracket_type === 'winner').map(i => i.m.round));
                for (const r of touchedWB) await ensureConsolationForRound(r);
                await advanceWBIfReady();
            }

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
       Vues (groupements par round)
       ============================ */
    const winnerMatches = useMemo(
        () => matches.filter((m) => m.bracket_type === 'winner'),
        [matches]
    );
    const loserMatches = useMemo(
        () => matches.filter((m) => m.bracket_type === 'loser'),
        [matches]
    );

    // En mode POOL, on filtre par onglet sélectionné
    const poolMatchesForUI = useMemo(() => {
        if (uiMode !== 'pool') return winnerMatches;
        if (!activePoolTab || poolTabs.labels.length === 0) return winnerMatches;
        if (activePoolTab === 'Playoffs') return [] as M[];

        const idx = poolTabs.labels.indexOf(activePoolTab);
        if (idx === -1) return winnerMatches;

        const idsSet = new Set(poolTabs.idsByPool[idx] || []);
        const roundsSet = new Set(poolTabs.roundsByPool[idx] || []);
        return winnerMatches.filter(
            (m) => m.player1 && m.player2 && idsSet.has(m.player1) && idsSet.has(m.player2) && roundsSet.has(m.round)
        );
    }, [uiMode, winnerMatches, activePoolTab, poolTabs]);

    const roundsWB = useMemo(() => {
        const src = uiMode === 'pool' ? poolMatchesForUI : winnerMatches;
        const byRound = new Map<number, M[]>();
        for (const m of src) {
            if (!byRound.has(m.round)) byRound.set(m.round, []);
            byRound.get(m.round)!.push(m);
        }
        for (const r of byRound.keys()) byRound.get(r)!.sort((a, b) => a.slot - b.slot);
        return [...byRound.entries()].sort((a, b) => a[0] - b[0]);
    }, [uiMode, poolMatchesForUI, winnerMatches]);

    const roundsLB = useMemo(() => {
        const byRound = new Map<number, M[]>();
        for (const m of loserMatches) {
            if (!byRound.has(m.round)) byRound.set(m.round, []);
            byRound.get(m.round)!.push(m);
        }
        for (const r of byRound.keys()) byRound.get(r)!.sort((a, b) => a.slot - b.slot);
        return [...byRound.entries()].sort((a, b) => a[0] - b[0]);
    }, [loserMatches]);

    /* ============================
       UI
       ============================ */
    return (
        <div className="container stack">
            {/* Notice / explications simples */}
            <div className="card">
                <div className="card__content stack" style={{ gap: 8 }}>
                    <div style={{ fontWeight: 700 }}>Comment ça marche</div>
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                        <li><b>Vider les matchs</b> remet le tableau à zéro.</li>
                        <li><b>Générer une bracket</b> crée <b>uniquement le Round 1</b>. Valide tous les gagnants, puis clique <b>Confirmer</b> pour faire apparaître le round suivant. Le <b>loser bracket</b> se crée automatiquement à la fin de chaque round WB.</li>
                        <li><b>Poules</b>: Génère 2/3/4 poules (Round Robin). Onglets <b>Pool 1..K</b> + <b>Playoffs</b> (placeholder).</li>
                        <li><b>Sélection de participants</b>: coche/décoche qui participe, puis <b>Générer une bracket (sélection)</b> pour, par ex., faire un top 4 après les poules.</li>
                    </ul>
                    <div style={{ fontSize: 12, opacity: 0.8 }}>
                        Limites actuelles: pas de génération auto des Playoffs depuis les poules (volontaire). Les tailles de bracket direct autorisées: 4, 7–8, 11–12, 15–16, 32.
                    </div>
                </div>
            </div>

            {/* Actions MANUELLES */}
            <div className="card">
                <div className="card__content hstack" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <span className="spacer" />
                    {canEdit && (
                        <>
                            <Button
                                variant="ghost"
                                onClick={() => {
                                    setIsBuilding(true);
                                    clearAllMatches()
                                        .then(() => {
                                            setUiMode('none');
                                            setPoolTabs({ labels: [], idsByPool: [], roundsByPool: [] });
                                            setActivePoolTab(null);
                                            setInfo(null);
                                        })
                                        .then(load)
                                        .finally(() => setIsBuilding(false));
                                }}
                            >
                                Vider les matchs
                            </Button>

                            <Button variant="primary" onClick={() => { setIsBuilding(true); generateBracketFromRoster().finally(() => setIsBuilding(false)); }}>
                                Générer une bracket
                            </Button>

                            <Button variant="ghost" onClick={() => generatePools(2)}>Générer 2 poules</Button>
                            <Button variant="ghost" onClick={() => generatePools(3)}>Générer 3 poules</Button>
                            <Button variant="ghost" onClick={() => generatePools(4)}>Générer 4 poules</Button>
                        </>
                    )}
                </div>
            </div>

            {/* Sélection des participants (checkboxes) */}
            {canEdit && (
                <div className="card">
                    <div className="card__content stack" style={{ gap: 10 }}>
                        <div className="hstack" style={{ gap: 8, flexWrap: 'wrap' }}>
                            <div style={{ fontWeight: 700 }}>Sélection des participants</div>
                            <span className="spacer" />
                            <Button variant="ghost" onClick={() => setSelectedIds(new Set(rosterIds))}>Tout cocher</Button>
                            <Button variant="ghost" onClick={() => setSelectedIds(new Set())}>Tout décocher</Button>
                            <Button variant="primary" onClick={() => generateBracketFromSelection()}>
                                Générer une bracket (sélection)
                            </Button>
                        </div>

                        <div className="grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(220px,1fr))', gap: 8 }}>
                            {rosterIds.map((id) => {
                                const checked = selectedIds.has(id);
                                return (
                                    <label key={id} className="hstack" style={{ gap: 8 }}>
                                        <input
                                            type="checkbox"
                                            checked={checked}
                                            onChange={(e) => {
                                                setSelectedIds((prev) => {
                                                    const next = new Set(prev);
                                                    if (e.target.checked) next.add(id); else next.delete(id);
                                                    return next;
                                                });
                                            }}
                                        />
                                        <span>{nameOf(id)}</span>
                                    </label>
                                );
                            })}
                            {rosterIds.length === 0 && <div style={{ opacity: 0.7 }}>Aucun participant détecté.</div>}
                        </div>
                    </div>
                </div>
            )}

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

            {/* Onglets : Bracket OU Pools */}
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
                {/* POOLS ou WINNER (selon mode/onglet) */}
                {uiMode === 'pool' && (activePoolTab ?? '') !== 'Playoffs' && roundsWB.map(([roundIdx, items]) => (
                    <div key={`pool-${roundIdx}`} className="stack">
                        <div className="round-title">Round {roundIdx} — {activePoolTab}</div>
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
                                                ? <span className="badge">Vainqueur : <b>{nameOf(m.winner)}</b></span>
                                                : pendingWinner
                                                    ? <span style={{ opacity: 0.9 }}>Sélectionné : {nameOf(pendingWinner)}</span>
                                                    : <span style={{ opacity: 0.6 }}>—</span>
                                            }
                                        </div>
                                        <div className="stack">
                                            <div className={`matchline ${m.status === 'done' && m.winner === m.player1 ? 'is-winner' : ''} ${isSelectedP1 ? 'is-pending' : ''}`}>
                                                <span>{nameOf(m.player1)}</span>
                                                {canEdit && m.player1 && m.status !== 'done' && (
                                                    <Button size="sm" variant="ghost" onClick={() => selectWinner(m, m.player1 as string)}>Gagnant</Button>
                                                )}
                                            </div>
                                            <div className={`matchline ${m.status === 'done' && m.winner === m.player2 ? 'is-winner' : ''} ${isSelectedP2 ? 'is-pending' : ''}`}>
                                                <span>{nameOf(m.player2)}</span>
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

                {/* BRACKET — WINNER uniquement si onglet Winner */}
                {uiMode === 'bracket' && activeBracket === 'winner' && roundsWB.map(([roundIdx, items]) => (
                    <div key={`wb-${roundIdx}`} className="stack">
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
                                                ? <span className="badge">Vainqueur : <b>{nameOf(m.winner)}</b></span>
                                                : pendingWinner
                                                    ? <span style={{ opacity: 0.9 }}>Sélectionné : {nameOf(pendingWinner)}</span>
                                                    : <span style={{ opacity: 0.6 }}>—</span>
                                            }
                                        </div>
                                        <div className="stack">
                                            <div className={`matchline ${m.status === 'done' && m.winner === m.player1 ? 'is-winner' : ''} ${isSelectedP1 ? 'is-pending' : ''}`}>
                                                <span>{nameOf(m.player1)}</span>
                                                {canEdit && m.player1 && m.status !== 'done' && (
                                                    <Button size="sm" variant="ghost" onClick={() => selectWinner(m, m.player1 as string)}>Gagnant</Button>
                                                )}
                                            </div>
                                            <div className={`matchline ${m.status === 'done' && m.winner === m.player2 ? 'is-winner' : ''} ${isSelectedP2 ? 'is-pending' : ''}`}>
                                                <span>{nameOf(m.player2)}</span>
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

                {/* BRACKET — LOSER uniquement si onglet Loser (FIX: n'affiche que le loser) */}
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
                                                ? <span className="badge">Vainqueur : <b>{nameOf(m.winner)}</b></span>
                                                : pendingWinner
                                                    ? <span style={{ opacity: 0.9 }}>Sélectionné : {nameOf(pendingWinner)}</span>
                                                    : <span style={{ opacity: 0.6 }}>—</span>
                                            }
                                        </div>
                                        <div className="stack">
                                            <div className={`matchline ${m.status === 'done' && m.winner === m.player1 ? 'is-winner' : ''} ${isSelectedP1 ? 'is-pending' : ''}`}>
                                                <span>{nameOf(m.player1)}</span>
                                                {canEdit && m.player1 && m.status !== 'done' && (
                                                    <Button size="sm" variant="ghost" onClick={() => selectWinner(m, m.player1 as string)}>Gagnant</Button>
                                                )}
                                            </div>
                                            <div className={`matchline ${m.status === 'done' && m.winner === m.player2 ? 'is-winner' : ''} ${isSelectedP2 ? 'is-pending' : ''}`}>
                                                <span>{nameOf(m.player2)}</span>
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

                {/* Placeholder Playoffs pour Pools */}
                {uiMode === 'pool' && (activePoolTab === 'Playoffs') && (
                    <div className="card">
                        <div className="card__content">
                            <b>Playoffs</b> — (désactivé pour l’instant). Utilise la sélection ci-dessus pour créer un bracket manuellement.
                        </div>
                    </div>
                )}

                {/* Rien à afficher */}
                {uiMode !== 'pool' && uiMode !== 'bracket' && !isBuilding && (
                    <div style={{ opacity: 0.7 }}>Aucun match à afficher.</div>
                )}
            </div>
        </div>
    );
}
