'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { Button, Segment } from '@/app/components/ui';

/**
 * ===========================
 * Types
 * ===========================
 */
type P = {
    id: string;
    first_name: string;
    last_name: string | null;
    wins?: number | null;
};

type M = {
    id: string;
    tournament_id: string;
    round: number;         // 1..K (toutes phases confondues par bracket_type)
    slot: number;          // 1..S
    bracket_type: 'winner' | 'loser'; // winner = poules + playoffs / loser = consolation
    status: 'pending' | 'done' | 'canceled';
    player1: string | null;
    player2: string | null;
    winner: string | null;
};

type MinimalMatchRow = Pick<M, 'winner' | 'status'>;

type TournamentMeta = {
    code: string;
    format?: 'pool' | 'bracket' | null;
};

/**
 * ===========================
 * Utils purs (pas d'I/O)
 * ===========================
 */
function isPowerOfTwo(n: number) {
    return n > 0 && (n & (n - 1)) === 0;
}
function nextPowerOfTwo(n: number) {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
}
function pairKey(a: string | null, b: string | null) {
    if (!a || !b) return '';
    return [a, b].sort().join('|');
}
function rotateOnce(circle: (string | null)[]) {
    if (circle.length <= 2) return circle.slice();
    const first = circle[0];
    const rest = circle.slice(1);
    const last = rest.pop() as string | null;
    return [first, last, ...rest];
}
function pairsFromCircle(circle: (string | null)[]) {
    const n = circle.length;
    const half = n / 2;
    const pairs: Array<[string | null, string | null]> = [];
    for (let i = 0; i < half; i++) pairs.push([circle[i], circle[n - 1 - i]]);
    return pairs;
}

/**
 * Répartition en poules :
 *  - Priorité aux poules de 4, sinon 3, exceptionnellement 5
 *  - Serpent (A,B,C,D,D,C,B,A, ...)
 */
function makeBalancedPools(ids: string[]): string[][] {
    const n = ids.length;

    // Nombre de poules heuristique :
    //  - 9–12  => 3 poules (4/4/3)
    //  - 13–16 => 4 poules (4/4/4/1 -> corrigé en 4/4/4/4 avec ajustements)
    //  - 17–24 => 4–6 poules -> vise taille 4
    //  - 25–32 => 6–8 poules -> vise taille 4
    const idealPoolSize = 4;
    let K = Math.max(2, Math.round(n / idealPoolSize));
    if (n <= 10) K = 2;
    if (n >= 20 && n <= 24) K = 6;
    if (n >= 25 && n <= 28) K = 7;
    if (n >= 29) K = 8;

    // serpentin
    const pools: string[][] = Array.from({ length: K }, () => []);
    let dir = 1;
    let i = 0;
    for (const id of ids) {
        pools[i].push(id);
        i += dir;
        if (i === K) {
            dir = -1;
            i = K - 1;
        } else if (i === -1) {
            dir = 1;
            i = 0;
        }
    }

    // Rééquilibrage doux : vise tailles 4, puis 3, max 5
    function tooBig(p: string[]) { return p.length > 5; }
    function tooSmall(p: string[]) { return p.length < 3; }

    let stabilized = false;
    let safety = 0;
    while (!stabilized && safety < 200) {
        safety++;
        stabilized = true;

        // Si une poule >5, déplace vers la plus petite
        const maxIdx = pools.reduce((bi, p, idx, arr) => (arr[bi].length >= p.length ? bi : idx), 0);
        const minIdx = pools.reduce((bi, p, idx, arr) => (arr[bi].length <= p.length ? bi : idx), 0);
        if (tooBig(pools[maxIdx]) && pools[minIdx].length < 5) {
            const moved = pools[maxIdx].pop() as string;
            pools[minIdx].push(moved);
            stabilized = false;
            continue;
        }

        // Si une poule <3, tire d’une poule la plus grande
        const minIdx2 = pools.reduce((bi, p, idx, arr) => (arr[bi].length <= p.length ? bi : idx), 0);
        const maxIdx2 = pools.reduce((bi, p, idx, arr) => (arr[bi].length >= p.length ? bi : idx), 0);
        if (tooSmall(pools[minIdx2]) && pools[maxIdx2].length > 3) {
            const moved = pools[maxIdx2].pop() as string;
            pools[minIdx2].push(moved);
            stabilized = false;
            continue;
        }
    }
    return pools;
}

/**
 * Anti re-match 1er tour playoffs :
 * Essaie de swap localement si un 1er retombe sur un adversaire de sa poule.
 */
function avoidRematchFirstRound(seedPairs: Array<[string | null, string | null]>, samePoolMap: Map<string, number>) {
    const pairs = seedPairs.map(([a, b]) => [a, b] as [string | null, string | null]);

    function inSamePool(a?: string | null, b?: string | null) {
        if (!a || !b) return false;
        return samePoolMap.get(a) === samePoolMap.get(b);
    }

    for (let i = 0; i < pairs.length; i++) {
        const [a, b] = pairs[i];
        if (!inSamePool(a, b)) continue;

        // Essaie d’échanger le "b" avec un autre "b"
        for (let j = i + 1; j < pairs.length; j++) {
            const [c, d] = pairs[j];
            if (!inSamePool(a, d) && !inSamePool(c, b)) {
                // swap b <-> d
                pairs[i][1] = d;
                pairs[j][1] = b;
                break;
            }
        }
    }
    return pairs;
}

/**
 * ===========================
 * Composant
 * ===========================
 */
export default function MatchList({
    tournamentId,
    canEdit,
}: {
    tournamentId: string;
    canEdit: boolean;
}) {
    const [matches, setMatches] = useState<M[]>([]);
    const [people, setPeople] = useState<Record<string, P>>({});
    const [tournament, setTournament] = useState<TournamentMeta | null>(null);

    const [activeBracket, setActiveBracket] = useState<'winner' | 'loser'>('winner');

    // Onglets multi-poules (UI)
    const [poolTabs, setPoolTabs] = useState<{
        enabled: boolean;
        K: number;
        roundsByPool: number[][];
        playoffsStart: number | null;
        labels: string[];
        idsByPool: string[][];
    }>({
        enabled: false,
        K: 0,
        roundsByPool: [],
        playoffsStart: null,
        labels: [],
        idsByPool: [],
    });
    const [activePoolTab, setActivePoolTab] = useState<string | null>(null);

    const [pending, setPending] = useState<Record<string, string>>({});
    const pendingCount = Object.keys(pending).length;

    const [podium, setPodium] = useState<{
        gold?: string | null;
        silver?: string | null;
        bronze?: string | null;
        fourth?: string | null;
        note?: string;
    } | null>(null);

    const [setupDone, setSetupDone] = useState(false);

    const [lastClick, setLastClick] = useState(0);
    function safeAction(fn: () => void) {
        const now = Date.now();
        if (now - lastClick < 400) return;
        setLastClick(now);
        fn();
    }

    /**
     * ===========================
     * Chargement / helpers I/O
     * ===========================
     */
    const load = useCallback(async () => {
        const { data: m } = await supabase
            .from('matches')
            .select('*')
            .eq('tournament_id', tournamentId)
            .order('round')
            .order('slot');
        setMatches(m || []);

        const { data: ps } = await supabase.from('profiles').select('id,first_name,last_name,wins');
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
            .select('code, format')
            .eq('id', tournamentId)
            .single()
            .then(({ data }) => {
                const val = data && typeof data.format === 'string' ? data.format : null;
                const format: TournamentMeta['format'] = val === 'pool' || val === 'bracket' ? val : null;
                setTournament({ code: data?.code || '', format });
            });
    }, [tournamentId]);

    const tournamentCode = tournament?.code || null;
    const tournamentFormat = tournament?.format ?? null;

    const label = (id: string | null) =>
        id ? `${people[id]?.first_name || '?'} ${people[id]?.last_name || ''}` : 'BYE';

    // Vue actuelle (après filtrage onglets)
    const bracketMatchesRaw = useMemo(
        () => matches.filter((m) => m.bracket_type === activeBracket),
        [matches, activeBracket]
    );

    const bracketMatches = useMemo(() => {
        if (activeBracket !== 'winner') return bracketMatchesRaw;

        const uiMode: 'pool' | 'bracket' | 'hybrid_multi' =
            tournamentFormat === 'pool'
                ? 'pool'
                : poolTabs.enabled
                    ? 'hybrid_multi'
                    : 'bracket';

        if (poolTabs.enabled && activePoolTab) {
            const ps = poolTabs.playoffsStart ?? Number.POSITIVE_INFINITY;
            if (activePoolTab === 'Playoffs') {
                return bracketMatchesRaw.filter((m) => m.round >= ps);
            }
            const idx = poolTabs.labels.indexOf(activePoolTab);
            if (idx >= 0) {
                const roster = new Set(poolTabs.idsByPool[idx] || []);
                return bracketMatchesRaw.filter((m) => {
                    if (m.round >= ps) return false;
                    if (!m.player1 || !m.player2) return false; // cache BYE en poule
                    return roster.has(m.player1) && roster.has(m.player2);
                });
            }
        }

        if (uiMode === 'pool') {
            return bracketMatchesRaw.filter((m) => m.player1 && m.player2);
        }

        return bracketMatchesRaw;
    }, [
        bracketMatchesRaw,
        poolTabs.enabled,
        poolTabs.playoffsStart,
        poolTabs.labels,
        poolTabs.idsByPool,
        activePoolTab,
        activeBracket,
        tournamentFormat,
    ]);

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

    /**
     * ===========================
     * Requêtes DB helpers
     * ===========================
     */
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

    // Participants détectés via la table matches (fallback R1 si nécessaire)
    async function getParticipantsAny(tId: string): Promise<string[]> {
        const { data } = await supabase
            .from('matches')
            .select('player1,player2')
            .eq('tournament_id', tId);

        type Row = { player1: string | null; player2: string | null };
        const ids = new Set<string>();
        (data as Row[] | null)?.forEach((m) => {
            if (m.player1) ids.add(m.player1);
            if (m.player2) ids.add(m.player2);
        });
        return [...ids];
    }

    async function getParticipantsFromR1(tId: string): Promise<string[]> {
        const { min } = await getAllRounds(tId, 'winner');
        const start = Math.max(1, min || 1);
        const r1 = await fetchRound(tId, 'winner', start);
        r1.sort((a, b) => a.slot - b.slot);

        const seen = new Set<string>();
        const ordered: string[] = [];
        for (const m of r1) {
            if (m.player1 && !seen.has(m.player1)) {
                ordered.push(m.player1);
                seen.add(m.player1);
            }
            if (m.player2 && !seen.has(m.player2)) {
                ordered.push(m.player2);
                seen.add(m.player2);
            }
        }
        return ordered;
    }

    async function getParticipantsOrdered(tId: string): Promise<string[]> {
        const any = await getParticipantsAny(tId);
        if (any.length > 0) return any;
        return await getParticipantsFromR1(tId);
    }

    /**
     * ===========================
     * Décision de format (1→32)
     * ===========================
     * - ≤5 : poule unique (RR)
     * - 6–8 : bracket SE 8 (BYE si <8)
     * - 9–12 : poules → SE 8
     * - 13–24 : poules → SE 16
     * - 25–32 : poules → SE 16 (ou SE 32 si N=32 exact)
     * - Si format forcé = 'bracket' et N puissance de 2 (≥8) => bracket direct
     */
    async function decideMode(tId: string): Promise<'pool' | 'bracket' | 'hybrid_multi'> {
        const ids = await getParticipantsOrdered(tId);
        const n = ids.length;

        if (tournamentFormat === 'pool') return 'pool';
        if (tournamentFormat === 'bracket') {
            if (n <= 6) return 'pool';
            if (isPowerOfTwo(n) && n >= 8) return 'bracket';
            return 'hybrid_multi';
        }

        if (n <= 5) return 'pool';
        if (n >= 6 && n <= 8) return 'bracket';
        if (n === 32) return 'bracket';
        return 'hybrid_multi';
    }

    /**
     * ===========================
     * CRUD matches
     * ===========================
     */
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

    async function setPlayersExact(
        tId: string,
        bracket: 'winner' | 'loser',
        round: number,
        slot: number,
        p1: string | null,
        p2: string | null
    ) {
        const m = await ensureMatch(tId, bracket, round, slot);
        await supabase.from('matches').update({ player1: p1, player2: p2 }).eq('id', m.id);
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
        const p1 = m.player1;
        const p2 = m.player2;
        if (p1 === playerId || p2 === playerId) return; // déjà placé

        let update: Partial<M> | null = null;
        if (prefer === 'player1') {
            if (!p1) update = { player1: playerId };
        } else if (prefer === 'player2') {
            if (!p2) update = { player2: playerId };
        } else {
            if (!p1) update = { player1: playerId };
            else if (!p2) update = { player2: playerId };
            else update = null;
        }
        if (update) await supabase.from('matches').update(update).eq('id', m.id);
    }

    /**
     * ===========================
     * POULES (RR / multi-poules)
     * ===========================
     */

    // BYE précédent (pour garantir max 1 BYE en poule)
    async function getPrevByePlayer(tId: string, round: number): Promise<string | null> {
        if (round <= 1) return null;
        const prev = await fetchRound(tId, 'winner', round - 1);
        for (const m of prev) {
            if (m.player1 && !m.player2) return m.player1;
            if (m.player2 && !m.player1) return m.player2;
        }
        return null;
    }

    // Poule unique (RR)
    async function ensureFullPoolSchedule(tId: string) {
        const ids = await getParticipantsOrdered(tId);
        const dedup = Array.from(new Set(ids));
        if (dedup.length < 2) return;

        const seed = dedup.length % 2 === 1 ? [...dedup, null] : dedup;
        const total = seed.length - 1;

        const { max } = await getAllRounds(tId, 'winner');
        if (max >= 2) return; // déjà planifié

        let circle = seed.slice();
        const allPrevPairs = new Set<string>();

        for (let round = 1; round <= total; round++) {
            if (round > 1) circle = rotateOnce(circle);
            const prevBye = await getPrevByePlayer(tId, round);

            let chosen: Array<[string | null, string | null]> | null = null;
            let attempt = 0;
            const maxAttempts = circle.length * 2;

            while (attempt < maxAttempts) {
                const pairs = pairsFromCircle(circle);

                const duplicate = pairs.some(([a, b]) => {
                    const k = pairKey(a, b);
                    return !!k && allPrevPairs.has(k);
                });

                let byeOk = true;
                const byePair = pairs.find(([a, b]) => a === null || b === null);
                if (byePair && prevBye) {
                    const byePlayer = (byePair[0] || byePair[1]) as string;
                    byeOk = byePlayer !== prevBye; // max 1 BYE par joueur
                }

                if (!duplicate && byeOk) {
                    chosen = pairs;
                    break;
                }
                circle = rotateOnce(circle);
                attempt++;
            }

            const pairs = chosen ?? pairsFromCircle(circle);
            let slot = 1;
            for (const [a, b] of pairs) {
                if (!a || !b) continue; // on ne stocke pas les BYE
                const mm = await ensureMatch(tId, 'winner', round, slot);
                if (!mm.player1 && !mm.player2 && mm.status !== 'done') {
                    await setPlayersExact(tId, 'winner', round, slot, a, b);
                    allPrevPairs.add(pairKey(a, b));
                }
                slot++;
            }
        }
    }

    // Multi-poules → intercalage des rounds (A1,B1,C1,D1, A2,B2,C2,D2, ...)
    async function ensureMultiPoolsSchedule(tId: string) {
        const ids = await getParticipantsOrdered(tId);
        if (ids.length <= 6) return;

        const pools = makeBalancedPools(ids);
        const { max } = await getAllRounds(tId, 'winner');
        const startRound = (max || 0) + 1;
        const K = pools.length;

        for (let p = 0; p < K; p++) {
            const group = pools[p];
            const seed = group.length % 2 === 0 ? group.slice() : [...group, null];
            const total = Math.max(1, seed.length - 1);

            let circle = seed.slice();
            const seenPairs = new Set<string>();

            for (let g = 0; g < total; g++) {
                if (g > 0) circle = rotateOnce(circle);
                const pairs = pairsFromCircle(circle);
                const round = startRound + g * K + p;

                let slot = 1;
                for (const [a, b] of pairs) {
                    if (!a || !b) continue;
                    if (seenPairs.has(pairKey(a, b))) continue;
                    const mm = await ensureMatch(tId, 'winner', round, slot);
                    if (!mm.player1 && !mm.player2 && mm.status !== 'done') {
                        await setPlayersExact(tId, 'winner', round, slot, a, b);
                        seenPairs.add(pairKey(a, b));
                    }
                    slot++;
                }
            }
        }
    }

    /**
     * ===========================
     * Passage Poules → Playoffs
     * ===========================
     */
    async function computePoolStandings(tId: string, rounds: number[], poolIds: Set<string>) {
        const wins = new Map<string, number>();
        poolIds.forEach((id) => wins.set(id, 0));
        for (const r of rounds) {
            const ms = await fetchRound(tId, 'winner', r);
            for (const m of ms) {
                if (m.status !== 'done' || !m.winner) continue;
                if (wins.has(m.winner)) wins.set(m.winner, (wins.get(m.winner) || 0) + 1);
            }
        }
        return [...wins.entries()].map(([id, w]) => ({ id, wins: w })).sort((a, b) => b.wins - a.wins);
    }

    const recomputePoolTabs = useCallback(async () => {
        const mode = await decideMode(tournamentId);
        if (mode !== 'hybrid_multi') {
            setPoolTabs({ enabled: false, K: 0, roundsByPool: [], playoffsStart: null, labels: [], idsByPool: [] });
            setActivePoolTab(null);
            return;
        }

        const { max } = await getAllRounds(tournamentId, 'winner');
        if (!max) {
            setPoolTabs({ enabled: false, K: 0, roundsByPool: [], playoffsStart: null, labels: [], idsByPool: [] });
            setActivePoolTab(null);
            return;
        }

        const roundsNonVides: number[] = [];
        for (let r = 1; r <= max; r++) {
            const ms = await fetchRound(tournamentId, 'winner', r);
            if (ms.length > 0) roundsNonVides.push(r);
        }
        if (roundsNonVides.length === 0) {
            setPoolTabs({ enabled: false, K: 0, roundsByPool: [], playoffsStart: null, labels: [], idsByPool: [] });
            setActivePoolTab(null);
            return;
        }

        // Estime K par périodicité
        let bestK = 0;
        let bestScore = -1;
        for (let K = 2; K <= 8; K++) {
            const buckets: number[][] = Array.from({ length: K }, () => []);
            for (let i = 0; i < roundsNonVides.length; i++) buckets[i % K].push(roundsNonVides[i]);
            const score = Math.min(...buckets.map((b) => b.length));
            if (score > bestScore) {
                bestScore = score;
                bestK = K;
            }
        }

        if (bestK === 0) {
            setPoolTabs({ enabled: false, K: 0, roundsByPool: [], playoffsStart: null, labels: [], idsByPool: [] });
            setActivePoolTab(null);
            return;
        }

        const roundsByPool: number[][] = Array.from({ length: bestK }, () => []);
        for (let i = 0; i < roundsNonVides.length; i++) roundsByPool[i % bestK].push(roundsNonVides[i]);

        const lastPoolRound = Math.max(...roundsByPool.flat());
        const playoffsHaveRounds = (await fetchRound(tournamentId, 'winner', lastPoolRound + 1)).length > 0;
        const playoffsStart = playoffsHaveRounds ? lastPoolRound + 1 : null;

        const labels = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.slice(0, bestK).split('');

        // Recalcule la répartition théorique pour afficher correctement les onglets
        const allIds = await getParticipantsOrdered(tournamentId);
        const pools = makeBalancedPools(allIds).slice(0, bestK);

        setPoolTabs({
            enabled: true,
            K: bestK,
            roundsByPool,
            playoffsStart,
            labels,
            idsByPool: pools,
        });
        setActivePoolTab((prev) => prev ?? labels[0] ?? 'Playoffs');
    }, [tournamentId]);

    async function computeQualifiedFromPools(target: 8 | 16) {
        const K = poolTabs.K;
        const roundsByPool = poolTabs.roundsByPool;
        if (!K || roundsByPool.length === 0) return { seeds: [] as string[], samePool: new Map<string, number>() };

        // Map joueur -> index de poule (pour anti re-match)
        const samePool = new Map<string, number>();
        poolTabs.idsByPool.forEach((ids, idx) => {
            ids.forEach((id) => samePool.set(id, idx));
        });

        // Classements de chaque poule (victoires)
        const firsts: string[] = [];
        const seconds: string[] = [];
        const thirds: string[] = [];
        const fourths: string[] = [];

        for (let p = 0; p < K; p++) {
            const rounds = roundsByPool[p];
            if (rounds.length === 0) continue;
            const ms0 = await fetchRound(tournamentId, 'winner', rounds[0]);
            const ids = new Set<string>(ms0.flatMap((m) => [m.player1, m.player2]).filter(Boolean) as string[]);
            const table = await computePoolStandings(tournamentId, rounds, ids);

            table[0]?.id && firsts.push(table[0].id);
            table[1]?.id && seconds.push(table[1].id);
            table[2]?.id && thirds.push(table[2].id);
            table[3]?.id && fourths.push(table[3].id);
        }

        // Remplissage des seeds selon la cible (8 ou 16)
        let seeds: string[] = [];
        if (target === 8) {
            // Top2 de chaque poule si K=4  => 8
            // Si K=3 => top2*3=6 + 2 meilleurs 3e
            if (K >= 4) {
                seeds = [...firsts, ...seconds].slice(0, 8);
            } else {
                const bestThirds = thirds.slice(0, Math.max(0, 8 - (firsts.length + seconds.length)));
                seeds = [...firsts, ...seconds, ...bestThirds].slice(0, 8);
            }
        } else {
            // target 16
            // K=4 => top4*4 = 16
            // K=5–8 => top2 de chaque = 10–16, puis meilleurs 3e/4e pour compléter 16
            if (K === 4) {
                seeds = [...firsts, ...seconds, ...thirds, ...fourths].slice(0, 16);
            } else {
                const base = [...firsts, ...seconds];
                const need = Math.max(0, 16 - base.length);
                const pool = [...thirds, ...fourths];
                seeds = [...base, ...pool.slice(0, need)].slice(0, 16);
            }
        }

        return { seeds, samePool };
    }

    /**
     * ===========================
     * Playoffs (SE) + BYE (1 tour)
     * ===========================
     */
    async function buildSEBracketFromSeeds(tId: string, seeds: string[], startRound: number, samePool?: Map<string, number>) {
        if (seeds.length < 2) return;

        // Canonique 1 vs last, 2 vs last-1, etc.
        const size = nextPowerOfTwo(seeds.length);
        const byes = size - seeds.length;

        // Tableau des slots (paires) round 1
        const pairs: Array<[string | null, string | null]> = [];
        for (let i = 0; i < size / 2; i++) {
            const a = i + 1;            // seed rank
            const b = size - i;         // seed rank
            const s1 = seeds[a - 1] ?? null;
            const s2 = seeds[b - 1] ?? null;
            pairs.push([s1, s2]);
        }

        // Place les BYE uniquement côté top seeds : chaque joueur ne peut recevoir qu’1 BYE (de fait)
        // Anti re-match 1er tour si possible (août : via samePool swap)
        const adjustedPairs = samePool ? avoidRematchFirstRound(pairs, samePool) : pairs;

        // Création R1
        let slot = 1;
        for (const [p1, p2] of adjustedPairs) {
            await setPlayersExact(tId, 'winner', startRound, slot, p1, p2);
            // Si BYE, auto-win pour le joueur présent
            if (p1 && !p2) {
                await supabase
                    .from('matches')
                    .update({ winner: p1, status: 'done' })
                    .eq('tournament_id', tId)
                    .eq('bracket_type', 'winner')
                    .eq('round', startRound)
                    .eq('slot', slot);
            } else if (!p1 && p2) {
                await supabase
                    .from('matches')
                    .update({ winner: p2, status: 'done' })
                    .eq('tournament_id', tId)
                    .eq('bracket_type', 'winner')
                    .eq('round', startRound)
                    .eq('slot', slot);
            }
            slot++;
        }

        // Crée structure des tours suivants (sans joueurs)
        let rSize = size / 2;
        let r = startRound + 1;
        while (rSize >= 1) {
            for (let s = 1; s <= rSize; s++) {
                await ensureMatch(tId, 'winner', r, s);
            }
            r++;
            rSize = rSize / 2;
        }
    }

    /**
     * ===========================
     * Loser Bracket (consolation simple)
     *  - Collecte des perdants de chaque "vague" du WB et les fait s'affronter
     *  - Evite la complexité d’un DE complet (plus fluide)
     * ===========================
     */
    async function ensureConsolationForRound(tId: string, wbRound: number) {
        const losers: string[] = [];
        const wbs = await fetchRound(tId, 'winner', wbRound);
        for (const m of wbs) {
            if (m.status !== 'done' || !m.winner) continue;
            const l = m.winner === m.player1 ? m.player2 : m.player1;
            if (l) losers.push(l);
        }
        if (losers.length < 2) return;

        // Round LB indexé comme wbRound (1→…)
        let slot = 1;
        for (let i = 0; i + 1 < losers.length; i += 2) {
            await setPlayersExact(tId, 'loser', wbRound, slot, losers[i], losers[i + 1]);
            slot++;
        }
    }

    /**
     * ===========================
     * Application des vainqueurs & propagation
     * ===========================
     */
    async function propagateWinnerWB(m: M, winnerId: string) {
        const nextRound = m.round + 1;
        const nextSlot = Math.ceil(m.slot / 2);
        const prefer = m.slot % 2 === 1 ? 'player1' : 'player2';
        await setPlayerOnMatch(m.tournament_id, 'winner', nextRound, nextSlot, winnerId, prefer);
    }

    async function applyWinner(m: M, winnerId: string) {
        const loserId = m.player1 === winnerId ? m.player2 : m.player1;
        await supabase.from('matches').update({ winner: winnerId, status: 'done' }).eq('id', m.id);

        const mode = await decideMode(m.tournament_id);

        // POULES : rien à propager
        if (mode === 'pool') return;

        // BRACKET complet (WB)
        if (m.bracket_type === 'winner') {
            // propagation WB
            const wNext = await fetchRound(m.tournament_id, 'winner', m.round + 1);
            if (wNext.length > 0) {
                await propagateWinnerWB(m, winnerId);
            }

            // Consolation (LB) : peuple par "vague" de perdants du round courant
            if (loserId) {
                await ensureConsolationForRound(m.tournament_id, m.round);
            }

            // Incrémenter victoires à la finale
            const { max } = await getAllRounds(m.tournament_id, 'winner');
            const isFinal = m.round === max;
            if (isFinal) {
                const { data: prof } = await supabase
                    .from('profiles')
                    .select('wins')
                    .eq('id', winnerId)
                    .single();
                const current = prof?.wins || 0;
                await supabase.from('profiles').update({ wins: current + 1 }).eq('id', winnerId);
            }
            return;
        }

        // LB : pas de propagation additionnelle (consolation simple)
    }

    /**
     * ===========================
     * Reset sécurisés
     * ===========================
     */
    async function clearPlayerEverywhere(
        tId: string,
        bracket: 'winner' | 'loser',
        fromRound: number,
        playerId: string
    ) {
        const { data: ms } = await supabase
            .from('matches')
            .select('*')
            .eq('tournament_id', tId)
            .eq('bracket_type', bracket)
            .gte('round', fromRound);

        for (const mm of ms || []) {
            const patch: Partial<M> = {};
            let touched = false;

            if (mm.player1 === playerId) {
                patch.player1 = null;
                touched = true;
            }
            if (mm.player2 === playerId) {
                patch.player2 = null;
                touched = true;
            }

            if (touched) {
                patch.winner = null;
                patch.status = 'pending';
                await supabase.from('matches').update(patch).eq('id', mm.id);
            }
        }
    }

    async function resetRecursive(m: M) {
        const tId = m.tournament_id;
        const prevWinner = m.winner;
        const p1 = m.player1;
        const p2 = m.player2;

        await supabase.from('matches').update({ winner: null, status: 'pending' }).eq('id', m.id);

        if (m.bracket_type === 'winner' && prevWinner) {
            await clearPlayerEverywhere(tId, 'winner', m.round + 1, prevWinner);
        }
        if (p1) await clearPlayerEverywhere(tId, 'loser', 1, p1);
        if (p2) await clearPlayerEverywhere(tId, 'loser', 1, p2);
    }

    /**
     * ===========================
     * Génération globale (setup)
     * ===========================
     */
    async function ensurePlayoffsFromPools(tId: string) {
        const ids = await getParticipantsOrdered(tId);
        const n = ids.length;

        const target: 8 | 16 = n <= 12 ? 8 : 16; // Heuristique propre
        const { max } = await getAllRounds(tId, 'winner');
        const start = (max || 0) + 1;

        const { seeds, samePool } = await computeQualifiedFromPools(target);
        if (seeds.length < 4) return;

        await buildSEBracketFromSeeds(tId, seeds, start, samePool);
    }

    useEffect(() => {
        (async () => {
            if (setupDone) return;

            const mode = await decideMode(tournamentId);

            if (mode === 'pool') {
                await ensureFullPoolSchedule(tournamentId);
                await load();
                await recomputePoolTabs();
                setSetupDone(true);
                return;
            }

            if (mode === 'bracket') {
                // Bracket direct : s'il n'existe aucun match, le construire à partir des participants détectés
                const { max } = await getAllRounds(tournamentId, 'winner');
                if (max === 0) {
                    const ids = await getParticipantsOrdered(tournamentId);
                    const unique = Array.from(new Set(ids));
                    if (unique.length >= 2) {
                        // Seeds = ordre actuel (à remplacer par ELO si dispo)
                        await buildSEBracketFromSeeds(tournamentId, unique, 1);
                    }
                }
                await load();
                await recomputePoolTabs(); // pas d’onglets ici, mais safe
                setSetupDone(true);
                return;
            }

            // hybrid_multi : poules -> playoffs
            if (mode === 'hybrid_multi') {
                await ensureMultiPoolsSchedule(tournamentId);
                await recomputePoolTabs();             // calcule K/onglets
                await ensurePlayoffsFromPools(tournamentId); // seed playoffs immédiatement (anti re-match inclus)
                await load();
                await recomputePoolTabs();
                setSetupDone(true);
                return;
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tournamentId, setupDone, tournamentFormat]);

    useEffect(() => {
        (async () => {
            await recomputePoolTabs();
        })();
    }, [matches, recomputePoolTabs]);

    /**
     * ===========================
     * Podium / fin
     * ===========================
     */
    async function computePodium() {
        const mode = await decideMode(tournamentId);

        if (mode === 'bracket' || mode === 'hybrid_multi') {
            const { max } = await getAllRounds(tournamentId, 'winner');
            let gold: string | null | undefined = null;
            let silver: string | null | undefined = null;
            let bronze: string | null | undefined = null;
            let fourth: string | null | undefined = null;

            if (max > 0) {
                const finals = await fetchRound(tournamentId, 'winner', max);
                if (finals.length >= 1) {
                    const f = finals[0];
                    if (f.status === 'done' && f.winner) {
                        gold = f.winner;
                        const opp = f.winner === f.player1 ? f.player2 : f.player1;
                        silver = opp || null;
                    }
                }
                // Bronze = finale consolation du dernier round loser si existante, sinon rien
                const { data: lbLast } = await supabase
                    .from('matches')
                    .select('*')
                    .eq('tournament_id', tournamentId)
                    .eq('bracket_type', 'loser')
                    .order('round', { ascending: false })
                    .order('slot', { ascending: true })
                    .limit(1);

                const lb = (lbLast?.[0] as M) || undefined;
                if (lb && lb.status === 'done' && lb.winner) {
                    bronze = lb.winner;
                    const opp = lb.winner === lb.player1 ? lb.player2 : lb.player1;
                    fourth = opp || null;
                }
            }
            setPodium({ gold, silver, bronze, fourth });
            return;
        }

        // Poule unique : si match d’appui final existe
        const ids = await getParticipantsOrdered(tournamentId);
        const n = ids.length;
        const totalRounds = (n % 2 === 0 ? n : n + 1) - 1;

        const playoff = await fetchRound(tournamentId, 'winner', totalRounds + 1);
        if (playoff.length >= 1 && playoff[0].status === 'done') {
            const f = playoff[0];
            const gold = f.winner;
            const silver = f.winner === f.player1 ? f.player2 : f.player1;
            setPodium({
                gold: gold ?? null,
                silver: silver ?? null,
                bronze: null,
                fourth: null,
                note: 'Résultat du match d’appui.',
            });
            return;
        }

        // Sinon : classement par total de victoires
        const { data: all } = await supabase
            .from('matches')
            .select('winner,status')
            .eq('tournament_id', tournamentId)
            .eq('bracket_type', 'winner');

        const rows: MinimalMatchRow[] = (all || []) as MinimalMatchRow[];
        const wins = new Map<string, number>();
        rows.forEach((mm) => {
            if (mm.status === 'done' && mm.winner) wins.set(mm.winner, (wins.get(mm.winner) || 0) + 1);
        });
        const ordered = [...wins.entries()].sort((a, b) => b[1] - a[1]);
        const first = ordered[0];
        const second = ordered[1];

        if (first && second && first[1] === second[1]) {
            if (playoff.length === 0) {
                await setPlayersExact(tournamentId, 'winner', totalRounds + 1, 1, first[0], second[0]);
                await load();
                await recomputePoolTabs();
            }
            setPodium({
                note: 'Égalité pour la 1ère place : un match d’appui a été créé. Jouez-le puis cliquez à nouveau sur "Finir le tournoi".',
            });
            return;
        } else {
            setPodium({
                gold: first?.[0] ?? null,
                silver: second?.[0] ?? null,
                bronze: ordered[2]?.[0] ?? null,
                note: 'Classement calculé par nombre total de victoires.',
            });
        }
    }

    async function finishTournament() {
        if (pendingCount > 0) await confirmPending();
        await computePodium();
    }

    /**
     * ===========================
     * Validation groupée
     * ===========================
     */
    function selectWinner(m: M, winnerId: string) {
        if (m.status === 'done') return;
        setPending((prev) => ({ ...prev, [m.id]: winnerId }));
    }
    function clearPending() {
        setPending({});
    }
    async function confirmPending() {
        if (pendingCount === 0) return;

        const items: { m: M; winnerId: string }[] = [];
        for (const [matchId, winnerId] of Object.entries(pending)) {
            const m = matches.find((x) => x.id === matchId);
            if (m && winnerId) items.push({ m, winnerId });
        }
        // WB d’abord, du plus petit round au plus grand → cohérent pour propagation
        items.sort((a, b) => {
            if (a.m.bracket_type !== b.m.bracket_type) return a.m.bracket_type === 'winner' ? -1 : 1;
            if (a.m.round !== b.m.round) return a.m.round - b.m.round;
            return a.m.slot - b.m.slot;
        });

        for (const it of items) await applyWinner(it.m, it.winnerId);

        setPending({});
        await load();
        await recomputePoolTabs();
    }

    const reset = async (m: M) => {
        await resetRecursive(m);
        await load();
        await recomputePoolTabs();
    };

    /**
     * ===========================
     * UI
     * ===========================
     */
    return (
        <div className="container stack">
            {/* Alerte format manquant */}
            {tournamentFormat == null && (
                <div className="card">
                    <div className="card__content" style={{ color: '#8a1c1c' }}>
                        ⚠️ Format du tournoi non défini dans <code>tournaments.format</code> (attendu: <b>pool</b> ou <b>bracket</b>).
                        La génération automatique s’adapte quand même selon le nombre de joueurs, mais je te recommande de fixer le format.
                    </div>
                </div>
            )}

            {/* Podium */}
            {podium && (
                <div className="podium fade-in stack">
                    <div style={{ fontWeight: 800 }}>🏁 Tournoi terminé — Podium</div>
                    {podium?.gold != null && (
                        <div>
                            🥇 1er : <b>{label(podium.gold)}</b>
                        </div>
                    )}
                    {podium?.silver != null && (
                        <div>
                            🥈 2e : <b>{label(podium.silver)}</b>
                        </div>
                    )}
                    {podium?.bronze != null && (
                        <div>
                            🥉 3e : <b>{label(podium.bronze)}</b>
                        </div>
                    )}
                    {podium?.fourth != null && (
                        <div>
                            4e : <b>{label(podium.fourth)}</b>
                        </div>
                    )}
                    {podium?.note && <div style={{ opacity: 0.85, fontSize: 13 }}>{podium.note}</div>}
                </div>
            )}

            {/* Top bar */}
            <div className="hstack">
                {tournamentCode && (
                    <div className="card" style={{ flex: 1 }}>
                        <div className="card__content hstack">
                            <span>
                                Code du tournoi : <b>{tournamentCode}</b>
                            </span>
                            <span className="spacer" />
                            <Button variant="ghost" onClick={() => navigator.clipboard.writeText(tournamentCode)}>
                                Copier
                            </Button>
                        </div>
                    </div>
                )}
                {canEdit && (
                    <Button variant="primary" onClick={() => safeAction(finishTournament)}>
                        Finir le tournoi
                    </Button>
                )}
            </div>

            {/* Sticky toolbar */}
            {canEdit && pendingCount > 0 && (
                <div className="toolbar hstack">
                    <span className="badge">✅ {pendingCount} victoire(s) en attente</span>
                    <span className="spacer" />
                    <Button variant="primary" onClick={() => safeAction(confirmPending)}>
                        Confirmer
                    </Button>
                    <Button variant="ghost" onClick={() => safeAction(clearPending)}>
                        Annuler
                    </Button>
                </div>
            )}

            {/* Winner / Loser segmented control */}
            <Segment
                value={activeBracket}
                onChange={(v) => setActiveBracket(v as 'winner' | 'loser')}
                items={[
                    { label: 'Winner Bracket', value: 'winner' },
                    { label: 'Loser Bracket', value: 'loser' },
                ]}
            />

            {/* Onglets de poules */}
            {activeBracket === 'winner' && poolTabs.enabled && (
                <Segment
                    value={activePoolTab || ''}
                    onChange={(v) => setActivePoolTab(v as string)}
                    items={[
                        ...poolTabs.labels.map((L) => ({ label: `Poule ${L}`, value: L })),
                        { label: 'Playoffs', value: 'Playoffs' },
                    ]}
                />
            )}

            {/* Rounds grid */}
            <div className="rounds">
                {rounds.length === 0 && <div style={{ opacity: 0.7 }}>Aucun match dans ce bracket.</div>}

                {rounds.map(([roundIdx, items]) => (
                    <div key={roundIdx} className="stack">
                        <div className="round-title">Round {roundIdx}</div>

                        {items.map((m) => {
                            const pendingWinner = pending[m.id];
                            const isSelectedP1 = pendingWinner && pendingWinner === m.player1;
                            const isSelectedP2 = pendingWinner && pendingWinner === m.player2;

                            return (
                                <div key={m.id} className="card">
                                    <div className="card__content stack">
                                        <div className="hstack">
                                            <div style={{ fontWeight: 700 }}>Match {m.slot}</div>
                                            <span className="spacer" />
                                            {m.status === 'done' ? (
                                                <span className="badge">
                                                    Vainqueur : <b>{label(m.winner)}</b>
                                                </span>
                                            ) : pendingWinner ? (
                                                <span style={{ opacity: 0.9 }}>Sélectionné : {label(pendingWinner)}</span>
                                            ) : (
                                                <span style={{ opacity: 0.6 }}>—</span>
                                            )}
                                        </div>

                                        {/* players */}
                                        <div className="stack">
                                            <div
                                                className={`matchline ${m.status === 'done' && m.winner === m.player1 ? 'is-winner' : ''
                                                    } ${isSelectedP1 ? 'is-pending' : ''}`}
                                            >
                                                <span>{label(m.player1)}</span>
                                                {canEdit && m.player1 && m.status !== 'done' && !podium && (
                                                    <Button
                                                        size="sm"
                                                        variant="ghost"
                                                        onClick={() => safeAction(() => selectWinner(m, m.player1 as string))}
                                                    >
                                                        Gagnant
                                                    </Button>
                                                )}
                                            </div>

                                            <div
                                                className={`matchline ${m.status === 'done' && m.winner === m.player2 ? 'is-winner' : ''
                                                    } ${isSelectedP2 ? 'is-pending' : ''}`}
                                            >
                                                <span>{label(m.player2)}</span>
                                                {canEdit && m.player2 && m.status !== 'done' && !podium && (
                                                    <Button
                                                        size="sm"
                                                        variant="ghost"
                                                        onClick={() => safeAction(() => selectWinner(m, m.player2 as string))}
                                                    >
                                                        Gagnant
                                                    </Button>
                                                )}
                                            </div>
                                        </div>

                                        {canEdit && !podium && (
                                            <div className="hstack" style={{ marginTop: 8 }}>
                                                <span className="spacer" />
                                                <Button size="sm" variant="danger" onClick={() => safeAction(() => reset(m))}>
                                                    Réinitialiser
                                                </Button>
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
