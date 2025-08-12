'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { Button, Segment } from '@/app/components/ui';

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

type MinimalMatchRow = Pick<M, 'winner' | 'status'>;

type TournamentMeta = {
    code: string;
    format?: 'pool' | 'bracket' | null;
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
    const [tournament, setTournament] = useState<TournamentMeta | null>(null);

    const [activeBracket, setActiveBracket] = useState<'winner' | 'loser'>('winner');

    // Onglets multi‑poules
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
        idsByPool: [],           // 👈 NEW
    });
    const [activePoolTab, setActivePoolTab] = useState<string | null>(null); // 'A','B','C','Playoffs'|null

    // Sélections en attente (matchId -> winnerId)
    const [pending, setPending] = useState<Record<string, string>>({});
    const pendingCount = Object.keys(pending).length;

    // Podium
    const [podium, setPodium] = useState<{
        gold?: string | null;
        silver?: string | null;
        bronze?: string | null;
        fourth?: string | null;
        note?: string;
    } | null>(null);

    // Pour éviter régénérations multiples
    const [setupDone, setSetupDone] = useState(false);

    // Anti-spam clic
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
    const tournamentFormat = tournament?.format ?? null; // 'pool' | 'bracket' | null

    const label = (id: string | null) =>
        id ? `${people[id]?.first_name || '?'} ${people[id]?.last_name || ''}` : 'BYE';

    // ------- helpers d’affichage --------
    const bracketMatchesRaw = useMemo(
        () => matches.filter((m) => m.bracket_type === activeBracket),
        [matches, activeBracket]
    );

    // Filtrage par onglet de poule (uniquement pour winner)
    const bracketMatches = useMemo(() => {
        if (activeBracket !== 'winner') return bracketMatchesRaw;

        // 👇 UI-only (ne pas utiliser ailleurs)
        const uiMode: 'pool' | 'bracket' | 'hybrid_multi' =
            tournamentFormat === 'pool'
                ? 'pool'
                : poolTabs.enabled
                    ? 'hybrid_multi'
                    : 'bracket';

        // --- Cas multi-poules avec onglets ---
        if (poolTabs.enabled && activePoolTab) {
            const ps = poolTabs.playoffsStart ?? Number.POSITIVE_INFINITY;

            if (activePoolTab === 'Playoffs') {
                // Playoffs : on affiche tout (les BYE éventuels sont permis en bracket)
                return bracketMatchesRaw.filter(m => m.round >= ps);
            }

            // Onglets A/B/C… : matches de la phase poules uniquement, et on cache BYE
            const idx = poolTabs.labels.indexOf(activePoolTab);
            if (idx >= 0) {
                const roster = new Set(poolTabs.idsByPool[idx] || []);
                return bracketMatchesRaw.filter(m => {
                    if (m.round >= ps) return false;            // pas les playoffs ici
                    if (!m.player1 || !m.player2) return false; // cache BYE en poule
                    return roster.has(m.player1) && roster.has(m.player2);
                });
            }
        }

        // --- Cas poule unique ---
        if (uiMode === 'pool') {
            // Cache BYE en poule simple
            return bracketMatchesRaw.filter(m => m.player1 && m.player2);
        }

        // --- Bracket pur : on montre tout ---
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

    // =========================================
    // ========== LOGIQUE TOURNOI ==============
    // =========================================

    // --------- helpers communs ---------
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

    // NEW: récupère les participants présents dans TOUT le tournoi (sans dépendre du R1)
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

    // Ancienne méthode (R1) — on la garde en fallback
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

    // Utilise d’abord “Any”, sinon fallback R1
    async function getParticipantsOrdered(tId: string): Promise<string[]> {
        const any = await getParticipantsAny(tId);
        if (any.length > 0) return any;
        return await getParticipantsFromR1(tId);
    }

    // ===== détection modes =====
    function isPowerOfTwo(n: number) {
        return n > 0 && (n & (n - 1)) === 0;
    }

    async function decideMode(tId: string): Promise<'pool' | 'bracket' | 'hybrid_multi'> {
        // Respecter un format forcé
        if (tournamentFormat === 'pool') return 'pool';
        if (tournamentFormat === 'bracket') {
            const ids = await getParticipantsOrdered(tId);
            const n = ids.length;
            if (n <= 6) return 'pool';
            if (isPowerOfTwo(n) && n >= 8) return 'bracket';
            return 'hybrid_multi';
        }

        // Auto
        const ids = await getParticipantsOrdered(tId);
        const n = ids.length;
        if (n <= 6) return 'pool';
        if (isPowerOfTwo(n) && n >= 8) return 'bracket';
        return 'hybrid_multi';
    }

    // ====== Helpers matches ======
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

    async function setBYEAutoWin(tId: string, round: number, slot: number, playerId: string | null) {
        if (!playerId) return;
        const m = await ensureMatch(tId, 'winner', round, slot);
        if (m.status === 'done') return;
        await supabase
            .from('matches')
            .update({ player1: m.player1, player2: m.player2, winner: playerId, status: 'done' })
            .eq('id', m.id);
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

    // ====== BRACKET (élimination) ======
    async function getPlannedWinnerFinalRound(tId: string): Promise<number> {
        const ids = await getParticipantsOrdered(tId);
        const nPlayers = Math.max(2, ids.length);
        return Math.ceil(Math.log2(nPlayers)); // 8 -> 3 (QF=1, SF=2, F=3)
    }

    async function ensureLoserSkeleton(tId: string) {
        const plannedMax = await getPlannedWinnerFinalRound(tId);
        if (plannedMax < 3) return;
        const qfRound = plannedMax - 2;
        const qfs = await fetchRound(tId, 'winner', qfRound);
        const qfCount = qfs.length;
        if (qfCount === 0) return;

        const lb1Matches = Math.max(1, qfCount / 2);
        for (let slot = 1; slot <= lb1Matches; slot++) await ensureMatch(tId, 'loser', 1, slot);
        await ensureMatch(tId, 'loser', 2, 1);
        await ensureMatch(tId, 'loser', 2, 2);
        await ensureMatch(tId, 'loser', 3, 1);
    }

    async function propagateWinnerWB(m: M, winnerId: string) {
        const nextRound = m.round + 1;
        const nextSlot = Math.ceil(m.slot / 2);
        const prefer = m.slot % 2 === 1 ? 'player1' : 'player2';
        await setPlayerOnMatch(m.tournament_id, 'winner', nextRound, nextSlot, winnerId, prefer);
    }

    async function propagateLoserFromQFToLB1(m: M, loserId: string) {
        const plannedMax = await getPlannedWinnerFinalRound(m.tournament_id);
        const qfRound = plannedMax - 2;
        if (m.round !== qfRound) return;

        const qfs = await fetchRound(m.tournament_id, 'winner', qfRound);
        const qfIndex = qfs.findIndex((x) => x.id === m.id) + 1;
        const qfCount = qfs.length;
        const group = qfCount / 2;

        let lb1Slot = qfIndex;
        let prefer: 'player1' | 'player2' = 'player1';
        if (qfIndex > group) {
            lb1Slot = qfIndex - group;
            prefer = 'player2';
        }
        await setPlayerOnMatch(m.tournament_id, 'loser', 1, lb1Slot, loserId, prefer);
    }

    async function propagateLoserFromSFToLB2(m: M, loserId: string) {
        const plannedMax = await getPlannedWinnerFinalRound(m.tournament_id);
        const sfRound = plannedMax - 1;
        if (m.round !== sfRound) return;

        const sfs = await fetchRound(m.tournament_id, 'winner', sfRound);
        const sfIndex = sfs.findIndex((x) => x.id === m.id) + 1;

        const targetSlot = sfIndex === 1 ? 2 : 1;
        await setPlayerOnMatch(m.tournament_id, 'loser', 2, targetSlot, loserId, 'auto');
    }

    async function propagateWinnerLB(m: M, winnerId: string) {
        if (m.bracket_type !== 'loser') return;
        if (m.round === 1) await setPlayerOnMatch(m.tournament_id, 'loser', 2, m.slot, winnerId, 'auto');
        else if (m.round === 2) await setPlayerOnMatch(m.tournament_id, 'loser', 3, 1, winnerId, 'auto');
    }

    // ====== LOGIQUE POULES ======
    function pairKey(a: string | null, b: string | null) {
        if (!a || !b) return '';
        return [a, b].sort().join('|');
    }

    async function getPrevByePlayer(tId: string, round: number): Promise<string | null> {
        if (round <= 1) return null;
        const prev = await fetchRound(tId, 'winner', round - 1);
        for (const m of prev) {
            if (m.player1 && !m.player2) return m.player1;
            if (m.player2 && !m.player1) return m.player2;
        }
        return null;
    }

    // Round-robin utils
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

    // Poule simple
    async function buildPoolSeed(tId: string): Promise<(string | null)[]> {
        const ids = await getParticipantsOrdered(tId);
        const dedup = Array.from(new Set(ids));
        return dedup.length % 2 === 1 ? [...dedup, null] : dedup;
    }

    async function getPoolTotalRounds(tId: string): Promise<number> {
        const ids = await getParticipantsOrdered(tId);
        const n = ids.length % 2 === 0 ? ids.length : ids.length + 1;
        return Math.max(1, n - 1);
    }

    async function ensureFullPoolSchedule(tId: string) {
        if (tournamentFormat !== 'pool') return;
        const seed = await buildPoolSeed(tId);
        if (seed.length < 2) return;
        const total = seed.length - 1;

        const { max } = await getAllRounds(tId, 'winner');
        if (max >= 2) return;

        let circle = seed.slice();

        for (let round = 1; round <= total; round++) {
            if (round > 1) circle = rotateOnce(circle);

            const prevBye = await getPrevByePlayer(tId, round);
            const allPrevPairs = new Set<string>();
            for (let r = 1; r < round; r++) {
                const ms = await fetchRound(tId, 'winner', r);
                ms.forEach((m) => allPrevPairs.add(pairKey(m.player1, m.player2)));
            }

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
                    byeOk = byePlayer !== prevBye;
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
                if (!a || !b) continue; // 👈 skip BYE en poule

                const mm = await ensureMatch(tId, 'winner', round, slot);
                if (!mm.player1 && !mm.player2 && mm.status !== 'done') {
                    await setPlayersExact(tId, 'winner', round, slot, a, b);
                }
                slot++;
            }
        }
    }

    // ====== MULTI-POULES (max 5 par poule) ======
    function splitIntoKPoolsMax5(ids: string[]): string[][] {
        // K = ceil(n/5), >=2
        const n = ids.length;
        const K = Math.max(2, Math.ceil(n / 5));
        const pools: string[][] = Array.from({ length: K }, () => []);
        // serpent
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
        // garde-fou
        for (let p = 0; p < pools.length; p++) {
            while (pools[p].length > 5) {
                const target = pools.reduce((best, arr, idx) => (arr.length < pools[best].length ? idx : best), 0);
                pools[target].push(pools[p].pop() as string);
            }
        }
        return pools;
    }

    async function ensureMultiPoolsSchedule(tId: string) {
        const ids = await getParticipantsOrdered(tId);
        if (ids.length <= 6) return;
        const pools = splitIntoKPoolsMax5(ids); // ex: 10 -> [[5],[5]], 14 -> [[5],[5],[4]]

        const { max } = await getAllRounds(tId, 'winner');
        const startRound = (max || 0) + 1;
        const K = pools.length;

        for (let p = 0; p < K; p++) {
            const group = pools[p];
            const seed = group.length % 2 === 0 ? group.slice() : [...group, null];
            const total = Math.max(1, seed.length - 1);

            let circle = seed.slice();
            for (let g = 0; g < total; g++) {
                if (g > 0) circle = rotateOnce(circle);
                const pairs = pairsFromCircle(circle);

                const round = startRound + g * K + p; // intercalage
                let slot = 1;
                for (const [a, b] of pairs) {
                    if (!a || !b) continue; // 👈 skip BYE en poule

                    const mm = await ensureMatch(tId, 'winner', round, slot);
                    if (!mm.player1 && !mm.player2 && mm.status !== 'done') {
                        await setPlayersExact(tId, 'winner', round, slot, a, b);
                    }
                    slot++;
                }

            }
        }
    }

    type PoolStandings = { id: string; wins: number }[];

    async function computePoolStandings(tId: string, rounds: number[], poolIds: Set<string>): Promise<PoolStandings> {
        const wins = new Map<string, number>();
        poolIds.forEach((id) => wins.set(id, 0));
        for (const r of rounds) {
            const ms = await fetchRound(tId, 'winner', r);
            for (const m of ms) {
                if (m.status !== 'done' || !m.winner) continue;
                if (wins.has(m.winner)) wins.set(m.winner, (wins.get(m.winner) || 0) + 1);
            }
        }
        return [...wins.entries()]
            .map(([id, w]) => ({ id, wins: w }))
            .sort((a, b) => b.wins - a.wins);
    }

    // Détection des blocs de poules + début playoffs — appelée après CHAQUE load()
    const recomputePoolTabs = useCallback(async () => {

        // 👉 NEW: ne pas afficher d’onglets si on n’est pas en mode multi‑poules
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

        // Estime K (2..4) en cherchant une périodicité “dense”
        let bestK = 0;
        let bestScore = -1;
        for (let K = 2; K <= 4; K++) {
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

        const allIds = await getParticipantsOrdered(tournamentId);
        const idsByPool = splitIntoKPoolsMax5(allIds).slice(0, bestK); // garde-fou si <= 4

        setPoolTabs({
            enabled: true,
            K: bestK,
            roundsByPool,
            playoffsStart,
            labels,
            idsByPool, // 👈 NEW
        });
        // Si onglet non défini, on ouvre Poule A
        setActivePoolTab((prev) => prev ?? labels[0] ?? 'Playoffs');
    }, [tournamentId]);

    // ===== Playoffs depuis poules =====
    async function computeQualifiedFromPools() {
        // utilise les données déjà stockées dans poolTabs
        const K = poolTabs.K;
        const roundsByPool = poolTabs.roundsByPool;
        if (!K || roundsByPool.length === 0) return { K: 0, firsts: [] as string[], seconds: [] as string[] };

        const firsts: string[] = [];
        const seconds: string[] = [];

        for (let p = 0; p < K; p++) {
            const rounds = roundsByPool[p];
            if (rounds.length === 0) continue;
            const ms0 = await fetchRound(tournamentId, 'winner', rounds[0]);
            const ids = new Set<string>(ms0.flatMap((m) => [m.player1, m.player2]).filter(Boolean) as string[]);
            const table = await computePoolStandings(tournamentId, rounds, ids);
            if (table[0]?.id) firsts.push(table[0].id);
            if (table[1]?.id) seconds.push(table[1].id);
        }
        return { K, firsts, seconds };
    }

    async function ensurePlayoffsFromPools(tId: string) {
        const { K, firsts, seconds } = await computeQualifiedFromPools();
        if (K === 0) return;
        const Q = firsts.length + seconds.length; // 2K

        const { max } = await getAllRounds(tId, 'winner');
        const start = (max || 0) + 1;

        if (Q === 4) {
            await setPlayersExact(tId, 'winner', start, 1, firsts[0], seconds[1]);
            await setPlayersExact(tId, 'winner', start, 2, firsts[1], seconds[0]);
            await ensureMatch(tId, 'winner', start + 1, 1);
            await ensureMatch(tId, 'loser', 3, 1); // petite finale
            return;
        }
        if (Q === 6) {
            const seeds = [...firsts, ...seconds]; // [A1,B1,C1,A2,B2,C2]
            await setPlayersExact(tId, 'winner', start, 1, seeds[2], seeds[5]); // 3 vs 6
            await setPlayersExact(tId, 'winner', start, 2, seeds[3], seeds[4]); // 4 vs 5
            await ensureMatch(tId, 'winner', start + 1, 1);
            await ensureMatch(tId, 'winner', start + 1, 2);
            await ensureMatch(tId, 'winner', start + 2, 1);
            await ensureMatch(tId, 'loser', 3, 1);
            return;
        }
        if (Q === 8) {
            const seeds = [...firsts, ...seconds]; // [A1,B1,C1,D1, A2,B2,C2,D2]
            await setPlayersExact(tId, 'winner', start, 1, seeds[0], seeds[7]);
            await setPlayersExact(tId, 'winner', start, 2, seeds[3], seeds[4]);
            await setPlayersExact(tId, 'winner', start, 3, seeds[2], seeds[5]);
            await setPlayersExact(tId, 'winner', start, 4, seeds[1], seeds[6]);
            await ensureMatch(tId, 'winner', start + 1, 1);
            await ensureMatch(tId, 'winner', start + 1, 2);
            await ensureMatch(tId, 'winner', start + 2, 1);
            await ensureMatch(tId, 'loser', 3, 1);
            return;
        }
        // fallback: top4
        const merged = [...firsts, ...seconds].slice(0, 4);
        if (merged.length === 4) {
            await setPlayersExact(tId, 'winner', start, 1, merged[0], merged[3]);
            await setPlayersExact(tId, 'winner', start, 2, merged[1], merged[2]);
            await ensureMatch(tId, 'winner', start + 1, 1);
            await ensureMatch(tId, 'loser', 3, 1);
        }
    }

    async function tryPropagatePoolsPlayoffs(m: M) {
        const currentRoundMatches = await fetchRound(m.tournament_id, 'winner', m.round);
        // QF -> SF (Q=6 or 8)
        if (currentRoundMatches.length >= 2 && currentRoundMatches.length <= 4) {
            const allDone = currentRoundMatches.every((x) => x.status === 'done');
            if (!allDone) return;
            const winners = currentRoundMatches
                .sort((a, b) => a.slot - b.slot)
                .map((mm) => mm.winner)
                .filter(Boolean) as string[];
            await setPlayersExact(m.tournament_id, 'winner', m.round + 1, 1, winners[0] || null, winners[1] || null);
            if (winners.length > 2) {
                await setPlayersExact(m.tournament_id, 'winner', m.round + 1, 2, winners[2] || null, winners[3] || null);
            }
            return;
        }

        // SF -> F + petite finale
        const semis = await fetchRound(m.tournament_id, 'winner', m.round);
        const isSF = semis.length === 2;
        if (isSF) {
            const bothDone = semis.every((x) => x.status === 'done');
            if (!bothDone) return;

            const [s1, s2] = semis.sort((a, b) => a.slot - b.slot);
            const f1 = s1.winner;
            const f2 = s2.winner;
            if (f1 && f2) await setPlayersExact(m.tournament_id, 'winner', m.round + 1, 1, f1, f2);

            const l1 = s1.winner === s1.player1 ? s1.player2 : s1.player1;
            const l2 = s2.winner === s2.player1 ? s2.player2 : s2.player1;
            if (l1 && l2) await setPlayersExact(m.tournament_id, 'loser', 3, 1, l1, l2);
        }
    }

    // --- Helpers de reset sûrs ---
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

    // ---------- Application d’un vainqueur ----------
    async function applyWinner(m: M, winnerId: string) {
        const loserId = m.player1 === winnerId ? m.player2 : m.player1;

        await supabase.from('matches').update({ winner: winnerId, status: 'done' }).eq('id', m.id);

        const mode = await decideMode(m.tournament_id);

        if (mode === 'bracket') {
            await ensureLoserSkeleton(m.tournament_id);

            if (m.bracket_type === 'winner') {
                const plannedMax = await getPlannedWinnerFinalRound(m.tournament_id);
                const isFinal = m.round === plannedMax;
                if (!isFinal) await propagateWinnerWB(m, winnerId);

                if (loserId) {
                    const qfRound = plannedMax - 2;
                    const sfRound = plannedMax - 1;
                    if (m.round === qfRound) await propagateLoserFromQFToLB1(m, loserId);
                    else if (m.round === sfRound) await propagateLoserFromSFToLB2(m, loserId);
                }
            } else {
                await propagateWinnerLB(m, winnerId);
            }

            const plannedMax2 = await getPlannedWinnerFinalRound(m.tournament_id);
            const isFinal2 = m.bracket_type === 'winner' && m.round === plannedMax2;
            if (isFinal2) {
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

        if (mode === 'pool') {
            // rien à propager
            return;
        }

        // mode === 'hybrid_multi'
        await tryPropagatePoolsPlayoffs(m);
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

        const items: { m: M; winnerId: string }[] = [];
        for (const [matchId, winnerId] of Object.entries(pending)) {
            const m = matches.find((x) => x.id === matchId);
            if (m && winnerId) items.push({ m, winnerId });
        }
        items.sort((a, b) => {
            if (a.m.bracket_type !== b.m.bracket_type) return a.m.bracket_type === 'winner' ? -1 : 1;
            if (a.m.round !== b.m.round) return a.m.round - b.m.round;
            return a.m.slot - b.m.slot;
        });

        for (const it of items) await applyWinner(it.m, it.winnerId);

        setPending({});
        await load();
        // après chaque changement, on recalcule les onglets poules si besoin
        await recomputePoolTabs();
    }

    const reset = async (m: M) => {
        await resetRecursive(m);
        await load();
        await recomputePoolTabs();
    };

    // ---------- Finir le tournoi + Podium ----------
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
                const { data: lb3 } = await supabase
                    .from('matches')
                    .select('*')
                    .eq('tournament_id', tournamentId)
                    .eq('bracket_type', 'loser')
                    .eq('round', 3)
                    .eq('slot', 1)
                    .limit(1);
                const lb = (lb3?.[0] as M) || undefined;
                if (lb && lb.status === 'done' && lb.winner) {
                    bronze = lb.winner;
                    const opp = lb.winner === lb.player1 ? lb.player2 : lb.player1;
                    fourth = opp || null;
                }
            }
            setPodium({ gold, silver, bronze, fourth });
            return;
        }

        // Poule unique
        const totalRounds = await getPoolTotalRounds(tournamentId);
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
                note:
                    'Égalité pour la 1ère place : un match d’appui a été créé. Jouez-le puis cliquez à nouveau sur "Finir le tournoi".',
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

    // ---------- Génération + détection onglets ----------
    useEffect(() => {
        (async () => {
            if (setupDone) return;

            const mode = await decideMode(tournamentId);

            if (mode === 'pool') {
                await ensureFullPoolSchedule(tournamentId);
                await load();
                await recomputePoolTabs(); // pas d’onglets ici normalement, mais safe
                setSetupDone(true);
                return;
            }

            if (mode === 'bracket') {
                await load();
                await recomputePoolTabs();
                setSetupDone(true);
                return;
            }

            if (mode === 'hybrid_multi') {
                // multi‑poules (max 5 par poule) -> playoffs
                await ensureMultiPoolsSchedule(tournamentId);
                // on calcule et place les playoffs *immédiatement*, pas besoin d’un 1er match validé
                await recomputePoolTabs();
                await ensurePlayoffsFromPools(tournamentId);
                await load();
                await recomputePoolTabs(); // recalcul des onglets + “Playoffs”
                setSetupDone(true);
                return;
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tournamentId, setupDone, tournamentFormat]);

    // Recalcule les onglets quand la liste des matches évolue (ex: validations, resets)
    useEffect(() => {
        (async () => {
            await recomputePoolTabs();
        })();
    }, [matches, recomputePoolTabs]);

    // =========================================
    // ================= UI ====================
    // =========================================
    return (
        <div className="container stack">
            {/* Alerte format manquant */}
            {tournamentFormat == null && (
                <div className="card">
                    <div className="card__content" style={{ color: '#8a1c1c' }}>
                        ⚠️ Format du tournoi non défini dans <code>tournaments.format</code> (attendu: <b>pool</b> ou <b>bracket</b>).
                        La génération automatique de calendrier est désactivée pour éviter toute erreur.
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
