'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { Button, Segment } from '@/app/components/ui';

/* ======================= Types ======================= */
type P = { id: string; first_name: string; last_name: string | null; wins?: number | null; };
type M = {
    id: string; tournament_id: string; round: number; slot: number;
    bracket_type: 'winner' | 'loser';
    status: 'pending' | 'done' | 'canceled';
    player1: string | null; player2: string | null; winner: string | null;
};
type MinimalMatchRow = Pick<M, 'winner' | 'status'>;
type TournamentMeta = { code: string; format?: 'pool' | 'bracket' | null };

/* ======================= Utils ======================= */
const nextPowerOfTwo = (n: number) => { let p = 1; while (p < n) p <<= 1; return p; };
const pairKey = (a: string | null, b: string | null) => !a || !b ? '' : [a, b].sort().join('|');

/** Round-robin canonique (ghost si impair) */
function rrRounds(ids: (string | null)[]) {
    const n = ids.length, total = n - 1, rounds: Array<Array<[string | null, string | null]>> = [];
    let arr = ids.slice();
    for (let r = 0; r < total; r++) {
        const pairs: Array<[string | null, string | null]> = [];
        for (let i = 0; i < n / 2; i++) pairs.push([arr[i], arr[n - 1 - i]]);
        rounds.push(pairs);
        const fixed = arr[0], rest = arr.slice(1);
        rest.unshift(rest.pop() as string | null);
        arr = [fixed, ...rest];
    }
    return rounds;
}

/** Nombre de poules simple (style “compétition internationale”) */
function choosePoolCount(n: number) {
    if (n <= 10) return 2;
    if (n <= 20) return 4;
    return 8; // jusqu'à 32
}

/** Répartition serpentin équilibrée */
function splitPools(ids: string[]) {
    const K = choosePoolCount(ids.length);
    const pools: string[][] = Array.from({ length: K }, () => []);
    let i = 0, dir = 1;
    for (const id of ids) { pools[i].push(id); i += dir; if (i === K) { dir = -1; i = K - 1; } else if (i === -1) { dir = 1; i = 0; } }
    // petit rééquilibrage: tailles entre 3 et 6
    let changed = true, guard = 0;
    while (changed && guard++ < 100) {
        changed = false;
        const maxI = pools.reduce((bi, p, idx, a) => a[bi].length >= p.length ? bi : idx, 0);
        const minI = pools.reduce((bi, p, idx, a) => a[bi].length <= p.length ? bi : idx, 0);
        if (pools[maxI].length > 6 && pools[minI].length < 6) { pools[minI].push(pools[maxI].pop() as string); changed = true; }
        const maxI2 = pools.reduce((bi, p, idx, a) => a[bi].length >= p.length ? bi : idx, 0);
        const minI2 = pools.reduce((bi, p, idx, a) => a[bi].length <= p.length ? bi : idx, 0);
        if (pools[minI2].length < 3 && pools[maxI2].length > 3) { pools[minI2].push(pools[maxI2].pop() as string); changed = true; }
    }
    return pools;
}

/* ======================= Composant ======================= */
export default function MatchList({ tournamentId, canEdit }: { tournamentId: string; canEdit: boolean }) {
    const [isBuilding, setIsBuilding] = useState(true);
    const [matches, setMatches] = useState<M[]>([]);
    const [people, setPeople] = useState<Record<string, P>>({});
    const [tournament, setTournament] = useState<TournamentMeta | null>(null);
    const [activeBracket, setActiveBracket] = useState<'winner' | 'loser'>('winner');

    // UI poules
    const [poolTabs, setPoolTabs] = useState<{ enabled: boolean; K: number; roundsByPool: number[][]; playoffsStart: number | null; labels: string[]; idsByPool: string[][]; }>({ enabled: false, K: 0, roundsByPool: [], playoffsStart: null, labels: [], idsByPool: [] });
    const [activePoolTab, setActivePoolTab] = useState<string | null>(null);

    const [pending, setPending] = useState<Record<string, string>>({});
    const pendingCount = Object.keys(pending).length;

    const [podium, setPodium] = useState<{ gold?: string | null; silver?: string | null; bronze?: string | null; fourth?: string | null; note?: string; } | null>(null);

    const [setupDone, setSetupDone] = useState(false);
    const [lastClick, setLastClick] = useState(0);
    const safeAction = (fn: () => void) => { const now = Date.now(); if (now - lastClick < 350) return; setLastClick(now); fn(); };

    /* ======================= I/O ======================= */
    const load = useCallback(async () => {
        const { data: m } = await supabase.from('matches').select('*').eq('tournament_id', tournamentId).order('round').order('slot');
        setMatches(m || []);
        const { data: ps } = await supabase.from('profiles').select('id,first_name,last_name,wins');
        const map: Record<string, P> = {}; (ps || []).forEach(p => map[p.id] = p as P); setPeople(map);
    }, [tournamentId]);

    useEffect(() => { load(); }, [load]);
    useEffect(() => {
        supabase.from('tournaments').select('code,format').eq('id', tournamentId).single()
            .then(({ data }) => {
                const val = (data?.format ?? null) as any;
                const format: TournamentMeta['format'] = val === 'pool' || val === 'bracket' ? val : null;
                setTournament({ code: data?.code || '', format });
            });
    }, [tournamentId]);

    const tournamentCode = tournament?.code || null;
    const label = (id: string | null) => id ? `${people[id]?.first_name || '?'} ${people[id]?.last_name || ''}` : 'BYE';

    const bracketMatchesRaw = useMemo(() => matches.filter(m => m.bracket_type === activeBracket), [matches, activeBracket]);

    const bracketMatches = useMemo(() => {
        if (activeBracket !== 'winner') return bracketMatchesRaw;
        if (poolTabs.enabled && activePoolTab) {
            const ps = poolTabs.playoffsStart ?? Number.POSITIVE_INFINITY;
            if (activePoolTab === 'Playoffs') return bracketMatchesRaw.filter(m => m.round >= ps);
            const idx = poolTabs.labels.indexOf(activePoolTab);
            if (idx >= 0) {
                const roster = new Set(poolTabs.idsByPool[idx] || []);
                return bracketMatchesRaw.filter(m => {
                    if (m.round >= ps) return false;
                    if (!m.player1 || !m.player2) return false;
                    return roster.has(m.player1) && roster.has(m.player2);
                });
            }
        }
        return bracketMatchesRaw;
    }, [bracketMatchesRaw, poolTabs.enabled, poolTabs.playoffsStart, poolTabs.labels, poolTabs.idsByPool, activePoolTab, activeBracket]);

    const rounds = useMemo(() => {
        const by = new Map<number, M[]>();
        for (const m of bracketMatches) { if (!by.has(m.round)) by.set(m.round, []); by.get(m.round)!.push(m); }
        for (const r of by.keys()) by.get(r)!.sort((a, b) => a.slot - b.slot);
        return [...by.entries()].sort((a, b) => a[0] - b[0]);
    }, [bracketMatches]);

    /* ======================= DB helpers ======================= */
    async function fetchRound(tId: string, bracket: 'winner' | 'loser', round: number): Promise<M[]> {
        if (!Number.isFinite(round)) return [];
        const { data } = await supabase.from('matches').select('*')
            .eq('tournament_id', tId).eq('bracket_type', bracket).eq('round', round)
            .order('slot', { ascending: true });
        return data || [];
    }
    async function getAllRounds(tId: string, bracket: 'winner' | 'loser') {
        const { data } = await supabase.from('matches').select('round').eq('tournament_id', tId).eq('bracket_type', bracket);
        const arr = (data || []).map(x => x.round);
        return { min: arr.length ? Math.min(...arr) : 0, max: arr.length ? Math.max(...arr) : 0 };
    }
    async function getParticipantsOrdered(tId: string) {
        const { data } = await supabase.from('matches').select('player1,player2').eq('tournament_id', tId);
        const ids = new Set<string>();
        (data as any[] || []).forEach(r => { if (r.player1) ids.add(r.player1); if (r.player2) ids.add(r.player2); });
        return [...ids];
    }

    /* ======================= CRUD matches ======================= */
    async function ensureMatch(tId: string, bracket: 'winner' | 'loser', round: number, slot: number): Promise<M> {
        const { data: existing } = await supabase.from('matches').select('*')
            .eq('tournament_id', tId).eq('bracket_type', bracket).eq('round', round).eq('slot', slot).limit(1);
        if (existing && existing[0]) return existing[0] as M;
        const { data: created, error } = await supabase.from('matches').insert({
            tournament_id: tId, bracket_type: bracket, round, slot, status: 'pending', player1: null, player2: null, winner: null
        }).select('*').single();
        if (error) throw error;
        return created as M;
    }
    async function setPlayersExact(tId: string, bracket: 'winner' | 'loser', round: number, slot: number, p1: string | null, p2: string | null) {
        const m = await ensureMatch(tId, bracket, round, slot);
        await supabase.from('matches').update({ player1: p1, player2: p2 }).eq('id', m.id);
    }
    async function setPlayerOnMatch(tId: string, bracket: 'winner' | 'loser', round: number, slot: number, playerId: string, prefer: 'player1' | 'player2' | 'auto' = 'auto') {
        const m = await ensureMatch(tId, bracket, round, slot);
        if (m.player1 === playerId || m.player2 === playerId) return;
        const patch: Partial<M> = {};
        if (prefer === 'player1') { if (!m.player1) patch.player1 = playerId; }
        else if (prefer === 'player2') { if (!m.player2) patch.player2 = playerId; }
        else { if (!m.player1) patch.player1 = playerId; else if (!m.player2) patch.player2 = playerId; }
        if (Object.keys(patch).length) await supabase.from('matches').update(patch).eq('id', m.id);
    }

    async function deleteWinnerFromRound(tId: string, from: number) {
        if (!Number.isFinite(from)) return;
        await supabase.from('matches')
            .delete()
            .eq('tournament_id', tId)
            .eq('bracket_type', 'winner')
            .gte('round', from);
    }

    /* ======================= Planning: POULES ======================= */
    async function ensureSinglePool(tId: string) {
        const ids = (await getParticipantsOrdered(tId));
        const players = [...new Set(ids)];
        if (players.length < 2) return;
        const seed = players.length % 2 === 1 ? [...players, null] : players;
        const roundsRR = rrRounds(seed);
        const { max } = await getAllRounds(tId, 'winner');
        if (max >= 1) return; // déjà planifié
        for (let r = 0; r < roundsRR.length; r++) {
            let slot = 1;
            for (const [a, b] of roundsRR[r]) {
                if (!a || !b) continue;
                await setPlayersExact(tId, 'winner', r + 1, slot++, a, b);
            }
        }
    }

    async function ensureMultiPools(tId: string) {
        const ids = (await getParticipantsOrdered(tId));
        const pools = splitPools(ids);
        const { max } = await getAllRounds(tId, 'winner');
        const start = (max || 0) + 1, K = pools.length;
        for (let p = 0; p < K; p++) {
            const g = pools[p];
            const seed = g.length % 2 === 0 ? g.slice() : [...g, null];
            const rr = rrRounds(seed);
            for (let k = 0; k < rr.length; k++) {
                const round = start + k * K + p;
                let slot = 1;
                for (const [a, b] of rr[k]) {
                    if (!a || !b) continue;
                    await setPlayersExact(tId, 'winner', round, slot++, a, b);
                }
            }
        }
    }

    /* ===== Onglets & détection poules/playoffs ===== */
    const recomputePoolTabs = useCallback(async () => {
        const ids = await getParticipantsOrdered(tournamentId);
        const n = ids.length;
        if (n <= 6) { // mode pool simple
            setPoolTabs({ enabled: false, K: 0, roundsByPool: [], playoffsStart: null, labels: [], idsByPool: [] });
            setActivePoolTab(null);
            return;
        }
        // multi-poules
        const pools = splitPools(ids);
        const labels = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.slice(0, pools.length).split('');
        const roster = pools.map(x => new Set(x));
        const { max } = await getAllRounds(tournamentId, 'winner');
        if (!max) {
            setPoolTabs({ enabled: true, K: pools.length, roundsByPool: [], playoffsStart: null, labels, idsByPool: pools });
            setActivePoolTab(prev => prev ?? labels[0] ?? null);
            return;
        }
        const roundsByPool: number[][] = Array.from({ length: pools.length }, () => []);
        const poolRoundSet = new Set<number>();
        for (let r = 1; r <= max; r++) {
            const ms = await fetchRound(tournamentId, 'winner', r);
            if (ms.length === 0) continue;
            const idsIn = new Set<string>();
            for (const m of ms) { if (m.player1) idsIn.add(m.player1); if (m.player2) idsIn.add(m.player2); }
            const idx = roster.findIndex(S => [...idsIn].every(id => S.has(id)));
            if (idx >= 0) { roundsByPool[idx].push(r); poolRoundSet.add(r); }
        }
        const lastPoolRound = poolRoundSet.size ? Math.max(...[...poolRoundSet]) : 0;
        const playoffsHave = lastPoolRound > 0 && (await fetchRound(tournamentId, 'winner', lastPoolRound + 1)).length > 0;
        const playoffsStart = playoffsHave ? lastPoolRound + 1 : null;
        setPoolTabs({ enabled: true, K: pools.length, roundsByPool, playoffsStart, labels, idsByPool: pools });
        setActivePoolTab(prev => prev ?? labels[0] ?? (playoffsHave ? 'Playoffs' : null));
    }, [tournamentId]);

    /* ======================= Classements poules ======================= */
    async function computePoolStandings(rounds: number[], idsInPool: Set<string>) {
        const wins = new Map<string, number>(); idsInPool.forEach(id => wins.set(id, 0));
        for (const r of rounds) {
            const ms = await fetchRound(tournamentId, 'winner', r);
            for (const m of ms) {
                if (m.status !== 'done' || !m.winner) continue;
                if (wins.has(m.winner)) wins.set(m.winner, (wins.get(m.winner) || 0) + 1);
            }
        }
        return [...wins.entries()].map(([id, w]) => ({ id, wins: w })).sort((a, b) => b.wins - a.wins);
    }

    /* ======================= Playoffs top-2/Pool ======================= */
    function buildPairsTop2(K: number, firsts: string[], seconds: string[]) {
        // croisement simple pour éviter re-match
        if (K === 2) {
            return [[firsts[0] || null, seconds[1] || null], [firsts[1] || null, seconds[0] || null]] as Array<[string | null, string | null]>;
        }
        if (K === 4) {
            return [
                [firsts[0] || null, seconds[1] || null],
                [firsts[1] || null, seconds[0] || null],
                [firsts[2] || null, seconds[3] || null],
                [firsts[3] || null, seconds[2] || null],
            ] as Array<[string | null, string | null]>;
        }
        // K=8 (ou générique) : 1 vs 2 suivant, par blocs de 2
        const pairs: Array<[string | null, string | null]> = [];
        for (let i = 0; i < K; i += 2) {
            pairs.push([firsts[i] || null, seconds[i + 1] || null]);
            pairs.push([firsts[i + 1] || null, seconds[i] || null]);
        }
        return pairs;
    }

    async function buildKOFromPairs(startRound: number, pairs: Array<[string | null, string | null]>) {
        // round 1 (QF / 1/8 / DF)
        let slot = 1;
        for (const [p1, p2] of pairs) {
            await setPlayersExact(tournamentId, 'winner', startRound, slot, p1, p2);
            // BYE -> auto win
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
        let size = pairs.length;
        let r = startRound + 1;
        while (size >= 1) {
            size = Math.floor(size / 2);
            if (size < 1) break;
            for (let s = 1; s <= size; s++) await ensureMatch(tournamentId, 'winner', r, s);
            r++;
        }
    }

    async function generatePlayoffsNow() {
        // toutes poules finies ?
        const { roundsByPool, idsByPool } = poolTabs;
        if (!roundsByPool.length) return;

        // check all done
        for (const rs of roundsByPool) {
            for (const r of rs) {
                const ms = await fetchRound(tournamentId, 'winner', r);
                if (ms.some(m => m.status !== 'done')) return; // on n'affiche rien si pas terminé
            }
        }
        const flat = roundsByPool.flat();
        if (flat.length === 0) return;
        const start = Math.max(...flat) + 1; // ronde de départ playoffs
        await deleteWinnerFromRound(tournamentId, start); // purge anciens playoffs

        // top-2 de chaque poule
        const firsts: string[] = []; const seconds: string[] = [];
        for (let p = 0; p < roundsByPool.length; p++) {
            const table = await computePoolStandings(roundsByPool[p], new Set(idsByPool[p]));
            if (table[0]) firsts.push(table[0].id);
            if (table[1]) seconds.push(table[1].id);
        }
        const pairs = buildPairsTop2(roundsByPool.length, firsts, seconds);
        await buildKOFromPairs(start, pairs);
    }

    async function ensurePlayoffsIfReady() {
        const rs = poolTabs.roundsByPool;
        if (!rs.length) return;
        // déjà présents ?
        const flat = rs.flat();
        if (!flat.length) return;
        const start = Math.max(...flat) + 1;
        const next = await fetchRound(tournamentId, 'winner', start);
        if (next.length > 0) return; // déjà créés
        // sinon, créer si tout est fini
        for (const rlist of rs) {
            for (const r of rlist) {
                const ms = await fetchRound(tournamentId, 'winner', r);
                if (ms.some(m => m.status !== 'done')) return;
            }
        }
        await generatePlayoffsNow();
    }

    /* ======================= Propagation / Résultats ======================= */
    async function propagateWinnerWB(m: M, winnerId: string) {
        const nextRound = m.round + 1;
        const nextSlot = Math.ceil(m.slot / 2);
        const prefer = m.slot % 2 === 1 ? 'player1' : 'player2';
        await ensureMatch(m.tournament_id, 'winner', nextRound, nextSlot); // <— toujours prépare
        await setPlayerOnMatch(m.tournament_id, 'winner', nextRound, nextSlot, winnerId, prefer);
    }

    async function ensureConsolationForRound(tId: string, wbRound: number) {
        const losers: string[] = [];
        const wbs = await fetchRound(tId, 'winner', wbRound);
        for (const m of wbs) {
            if (m.status !== 'done' || !m.winner) continue;
            const l = m.winner === m.player1 ? m.player2 : m.player1;
            if (l) losers.push(l);
        }
        if (losers.length < 2) return;
        let slot = 1;
        for (let i = 0; i + 1 < losers.length; i += 2) {
            await setPlayersExact(tId, 'loser', wbRound, slot, losers[i], losers[i + 1]); slot++;
        }
    }

    async function applyWinner(m: M, winnerId: string) {
        const loserId = m.player1 === winnerId ? m.player2 : m.player1;
        await supabase.from('matches').update({ winner: winnerId, status: 'done' }).eq('id', m.id);

        if (m.bracket_type === 'winner') {
            await propagateWinnerWB(m, winnerId);
            if (loserId) await ensureConsolationForRound(m.tournament_id, m.round);
            const { max } = await getAllRounds(m.tournament_id, 'winner');
            if (m.round === max) {
                const { data: prof } = await supabase.from('profiles').select('wins').eq('id', winnerId).single();
                await supabase.from('profiles').update({ wins: (prof?.wins || 0) + 1 }).eq('id', winnerId);
            }
        }
    }

    async function clearPlayerEverywhere(tId: string, bracket: 'winner' | 'loser', fromRound: number, playerId: string) {
        const { data: ms } = await supabase.from('matches').select('*')
            .eq('tournament_id', tId).eq('bracket_type', bracket).gte('round', fromRound);
        for (const mm of ms || []) {
            const patch: Partial<M> = {}; let touched = false;
            if (mm.player1 === playerId) { patch.player1 = null; touched = true; }
            if (mm.player2 === playerId) { patch.player2 = null; touched = true; }
            if (touched) { patch.winner = null; patch.status = 'pending'; await supabase.from('matches').update(patch).eq('id', mm.id); }
        }
    }
    async function resetRecursive(m: M) {
        const tId = m.tournament_id, prevWinner = m.winner, p1 = m.player1, p2 = m.player2;
        await supabase.from('matches').update({ winner: null, status: 'pending' }).eq('id', m.id);
        if (m.bracket_type === 'winner' && prevWinner) await clearPlayerEverywhere(tId, 'winner', m.round + 1, prevWinner);
        if (p1) await clearPlayerEverywhere(tId, 'loser', 1, p1);
        if (p2) await clearPlayerEverywhere(tId, 'loser', 1, p2);
    }

    /* ======================= Setup ======================= */
    async function initialBuild() {
        setIsBuilding(true);
        const ids = await getParticipantsOrdered(tournamentId);
        const n = ids.length;

        if (n <= 6) {
            // Toujours poule unique
            await deleteWinnerFromRound(tournamentId, 1); // purge éventuels brackets résiduels
            await ensureSinglePool(tournamentId);
            await load(); await recomputePoolTabs();
            setIsBuilding(false); setSetupDone(true); return;
        }

        // Multi-poules -> Playoffs top2/poule
        await ensureMultiPools(tournamentId);
        await load(); await recomputePoolTabs();
        await ensurePlayoffsIfReady();
        await load(); await recomputePoolTabs();
        setIsBuilding(false); setSetupDone(true);
    }

    useEffect(() => { if (!setupDone) { initialBuild(); } }, [setupDone, tournamentId]);

    useEffect(() => {
        (async () => {
            await recomputePoolTabs();
            // si toutes poules sont finies, crée (ou recrée) les playoffs
            await ensurePlayoffsIfReady();
            await load(); await recomputePoolTabs();
        })();
    }, [matches]); // eslint-disable-line

    /* ======================= Podium ======================= */
    async function computePodium() {
        const { max } = await getAllRounds(tournamentId, 'winner');
        if (max > 0) {
            const finals = await fetchRound(tournamentId, 'winner', max);
            let gold: null | string = null, silver: null | string = null;
            if (finals.length >= 1) {
                const f = finals[0];
                if (f.status === 'done' && f.winner) { gold = f.winner; silver = (f.winner === f.player1 ? f.player2 : f.player1) || null; }
            }
            setPodium({ gold, silver });
        }
    }
    async function finishTournament() { if (pendingCount > 0) await confirmPending(); await computePodium(); }

    /* ======================= Validation ======================= */
    function selectWinner(m: M, winnerId: string) { if (m.status === 'done') return; setPending(prev => ({ ...prev, [m.id]: winnerId })); }
    function clearPending() { setPending({}); }

    async function confirmPending() {
        if (pendingCount === 0) return;
        setIsBuilding(true);
        const items: { m: M; winnerId: string }[] = [];
        for (const [matchId, winnerId] of Object.entries(pending)) {
            const m = matches.find(x => x.id === matchId); if (m && winnerId) items.push({ m, winnerId });
        }
        items.sort((a, b) => a.m.bracket_type !== b.m.bracket_type ? (a.m.bracket_type === 'winner' ? -1 : 1) : a.m.round - b.m.round || a.m.slot - b.m.slot);
        for (const it of items) await applyWinner(it.m, it.winnerId);
        setPending({});
        await load(); await recomputePoolTabs(); await ensurePlayoffsIfReady(); await load(); await recomputePoolTabs();
        setIsBuilding(false);
    }

    const reset = async (m: M) => { setIsBuilding(true); await resetRecursive(m); await load(); await recomputePoolTabs(); setIsBuilding(false); };

    /* ======================= UI ======================= */
    return (
        <div className="container stack">
            {isBuilding && (
                <div className="card"><div className="card__content" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div className="spinner" /> Préparation : poules / classements / playoffs…
                </div></div>
            )}

            {/* Top bar */}
            <div className="hstack">
                {tournamentCode && (
                    <div className="card" style={{ flex: 1 }}>
                        <div className="card__content hstack">
                            <span>Code du tournoi : <b>{tournamentCode}</b></span>
                            <span className="spacer" />
                            <Button variant="ghost" onClick={() => navigator.clipboard.writeText(tournamentCode!)}>Copier</Button>
                        </div>
                    </div>
                )}
                {canEdit && (
                    <>
                        {poolTabs.enabled && (
                            <Button variant="ghost" onClick={() => safeAction(async () => { setIsBuilding(true); await generatePlayoffsNow(); await load(); await recomputePoolTabs(); setIsBuilding(false); })}>
                                Générer les playoffs
                            </Button>
                        )}
                        <Button variant="primary" onClick={() => safeAction(finishTournament)}>Finir le tournoi</Button>
                    </>
                )}
            </div>

            {/* Toolbar validations */}
            {canEdit && pendingCount > 0 && (
                <div className="toolbar hstack">
                    <span className="badge">✅ {pendingCount} victoire(s) en attente</span>
                    <span className="spacer" />
                    <Button variant="primary" onClick={() => safeAction(confirmPending)}>Confirmer</Button>
                    <Button variant="ghost" onClick={() => safeAction(clearPending)}>Annuler</Button>
                </div>
            )}

            {/* Bracket switch */}
            <Segment value={activeBracket} onChange={(v) => setActiveBracket(v as any)} items={[{ label: 'Winner Bracket', value: 'winner' }, { label: 'Loser Bracket', value: 'loser' }]} />

            {/* Pool tabs */}
            {activeBracket === 'winner' && poolTabs.enabled && (
                <Segment value={activePoolTab || ''} onChange={(v) => setActivePoolTab(v as string)}
                    items={[...poolTabs.labels.map(L => ({ label: `Poule ${L}`, value: L })), { label: 'Playoffs', value: 'Playoffs' }]} />
            )}

            {/* Rounds */}
            <div className="rounds">
                {rounds.length === 0 && !isBuilding && <div style={{ opacity: 0.7 }}>Aucun match dans ce bracket.</div>}

                {rounds.map(([rIdx, items]) => (
                    <div key={rIdx} className="stack">
                        <div className="round-title">Round {rIdx}</div>
                        {items.map(m => {
                            const pend = pending[m.id];
                            const s1 = pend && pend === m.player1;
                            const s2 = pend && pend === m.player2;
                            return (
                                <div key={m.id} className="card">
                                    <div className="card__content stack">
                                        <div className="hstack">
                                            <div style={{ fontWeight: 700 }}>Match {m.slot}</div>
                                            <span className="spacer" />
                                            {m.status === 'done'
                                                ? <span className="badge">Vainqueur : <b>{label(m.winner)}</b></span>
                                                : pend ? <span style={{ opacity: 0.9 }}>Sélectionné : {label(pend)}</span>
                                                    : <span style={{ opacity: 0.6 }}>—</span>}
                                        </div>
                                        <div className="stack">
                                            <div className={`matchline ${m.status === 'done' && m.winner === m.player1 ? 'is-winner' : ''} ${s1 ? 'is-pending' : ''}`}>
                                                <span>{label(m.player1)}</span>
                                                {canEdit && m.player1 && m.status !== 'done' && !podium && (
                                                    <Button size="sm" variant="ghost" onClick={() => safeAction(() => selectWinner(m, m.player1 as string))}>Gagnant</Button>
                                                )}
                                            </div>
                                            <div className={`matchline ${m.status === 'done' && m.winner === m.player2 ? 'is-winner' : ''} ${s2 ? 'is-pending' : ''}`}>
                                                <span>{label(m.player2)}</span>
                                                {canEdit && m.player2 && m.status !== 'done' && !podium && (
                                                    <Button size="sm" variant="ghost" onClick={() => safeAction(() => selectWinner(m, m.player2 as string))}>Gagnant</Button>
                                                )}
                                            </div>
                                        </div>
                                        {canEdit && !podium && (
                                            <div className="hstack" style={{ marginTop: 8 }}>
                                                <span className="spacer" />
                                                <Button size="sm" variant="danger" onClick={() => safeAction(() => reset(m))}>Réinitialiser</Button>
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
