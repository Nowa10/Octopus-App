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

type MinimalMatchRow = Pick<M, 'winner' | 'status'>;

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

    // Podium
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

    // ====== Participants & mode ======
    async function getParticipantsOrdered(tId: string): Promise<string[]> {
        // On lit le smallest round winner et on récupère l’ordre par slot
        const { min } = await getAllRounds(tId, 'winner');
        const r1 = await fetchRound(tId, 'winner', Math.max(1, min || 1));
        const seen = new Set<string>();
        const ordered: string[] = [];
        for (const m of r1.sort((a, b) => a.slot - b.slot)) {
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

    // > 6 => bracket ; ≤ 6 => poule
    async function isBracketMode(tId: string): Promise<boolean> {
        const parts = await getParticipantsOrdered(tId);
        return parts.length > 6;
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

    // ====== BRACKET (élimination) ======

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

    async function getPlannedWinnerFinalRound(tId: string): Promise<number> {
        const { firstCount } = await getFirstRoundInfo(tId);
        if (firstCount <= 1) return 1;
        const playersApprox = Math.max(2, firstCount * 2);
        return Math.ceil(Math.log2(playersApprox));
    }

    async function ensureLoserSkeleton(tId: string) {
        const plannedMax = await getPlannedWinnerFinalRound(tId);
        if (plannedMax < 3) return;
        for (let slot = 1; slot <= 2; slot++) {
            await ensureMatch(tId, 'loser', 1, slot);
        }
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
        const qfIndex = qfs.findIndex((x) => x.id === m.id) + 1; // 1..4
        const group = 2;

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
        const sfIndex = sfs.findIndex((x) => x.id === m.id) + 1; // 1 ou 2
        const targetSlot = sfIndex === 1 ? 2 : 1;
        await setPlayerOnMatch(m.tournament_id, 'loser', 2, targetSlot, loserId, 'auto');
    }

    async function propagateWinnerLB(m: M, winnerId: string) {
        if (m.round === 1) {
            await setPlayerOnMatch(m.tournament_id, 'loser', 2, m.slot, winnerId, 'auto');
        } else if (m.round === 2) {
            await setPlayerOnMatch(m.tournament_id, 'loser', 3, 1, winnerId, 'auto');
        }
    }

    // ====== POULE (round-robin, robuste) ======

    // Seed canonique (Berger) respectant le Round 1 existant (par slots), avec exactement 1 BYE si impair
    async function buildPoolSeed(tId: string): Promise<(string | null)[]> {
        const { min } = await getAllRounds(tId, 'winner');
        const r1 = await fetchRound(tId, 'winner', Math.max(1, min || 1));
        // pairs du round 1 triés par slot
        r1.sort((a, b) => a.slot - b.slot);
        const firsts = r1.map((m) => m.player1);
        const seconds = r1.map((m) => m.player2).reverse(); // pour que R1(DB) == R1(Berger)
        const ids = [...firsts, ...seconds].filter((x): x is string | null => true);

        // Normalisation: un seul BYE si impair
        const players = ids.filter((x): x is string => !!x);
        if (players.length % 2 === 1) return [...players, null];
        return players;
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
        for (let i = 0; i < half; i++) {
            pairs.push([circle[i], circle[n - 1 - i]]);
        }
        return pairs;
    }

    function pairKey(a: string | null, b: string | null) {
        if (!a || !b) return '';             // pas de clé pour un BYE
        return [a, b].sort().join('|');
    }

    async function getStartRound(tId: string) {
        const { min } = await getAllRounds(tId, 'winner');
        return Math.max(1, min || 1);
    }

    // Toutes les paires déjà jouées jusqu’à `uptoRound` inclus
    async function playedPairsUntil(tId: string, uptoRound: number) {
        const start = await getStartRound(tId);
        const keys = new Set<string>();
        for (let r = start; r <= Math.max(start, uptoRound); r++) {
            const ms = await fetchRound(tId, 'winner', r);
            ms.forEach(m => keys.add(pairKey(m.player1, m.player2)));
        }
        return keys;
    }

    // Compte des BYE pour chaque joueur jusqu’au round-1
    async function countByesUpToRound(tId: string, uptoRound: number) {
        const start = await getStartRound(tId);
        const counts = new Map<string, number>();
        for (let r = start; r < uptoRound; r++) {
            const ms = await fetchRound(tId, 'winner', r);
            for (const m of ms) {
                if (m.player1 && !m.player2) counts.set(m.player1, (counts.get(m.player1) || 0) + 1);
                if (m.player2 && !m.player1) counts.set(m.player2, (counts.get(m.player2) || 0) + 1);
            }
        }
        return counts;
    }

    async function getPoolTotalRounds(tId: string): Promise<number> {
        const ids = await getParticipantsOrdered(tId);
        const nWithBye = ids.length % 2 === 0 ? ids.length : ids.length + 1;
        return Math.max(1, nWithBye - 1);
    }

    // Crée/écrit le round N (évite rematch immédiat + équilibre BYE)
    async function ensurePoolRound(tId: string, round: number) {
        const seed = await buildPoolSeed(tId);           // joueurs + éventuellement null
        const total = Math.max(1, seed.length - 1);
        if (round < 1 || round > total) return;

        const expectedBye = seed.includes(null) ? 1 : 0;
        const allPrevPairs = await playedPairsUntil(tId, round - 1);
        const byeCounts = await countByesUpToRound(tId, round);
        const players = seed.filter(Boolean) as string[];
        const minBye = players.reduce((m, p) => Math.min(m, byeCounts.get(p) || 0), Infinity);
        const minByeSet = new Set(players.filter(p => (byeCounts.get(p) || 0) === minBye));

        let circle = seed.slice();
        // on essaye plusieurs rotations jusqu’à satisfaire les contraintes
        for (let tries = 0; tries < circle.length * 2; tries++) {
            const pairs = pairsFromCircle(circle);

            // 1) aucune paire déjà jouée
            const duplicate = pairs.some(([a, b]) => {
                const k = pairKey(a, b);
                return k && allPrevPairs.has(k);
            });

            // 2) BYE donné uniquement à un joueur au minimum actuel
            let byeOk = expectedBye === 0;
            const byePair = pairs.find(([a, b]) => a === null || b === null);
            if (expectedBye === 1) {
                if (!byePair) byeOk = false;
                else {
                    const byePlayer = (byePair[0] || byePair[1]) as string;
                    byeOk = minByeSet.has(byePlayer);
                }
            }

            if (!duplicate && byeOk) {
                let slot = 1;
                for (const [a, b] of pairs) {
                    await setPlayersExact(tId, 'winner', round, slot, a, b);
                    slot++;
                }
                return;
            }
            circle = rotateOnce(circle);
        }

        // Fallback (ne devrait pas se produire)
        let slot = 1;
        for (const [a, b] of pairsFromCircle(circle)) {
            await setPlayersExact(tId, 'winner', round, slot, a, b);
            slot++;
        }
    }

    // Avance la poule round-par-round
    async function ensurePoolProgress(tId: string) {
        const seed = await buildPoolSeed(tId);
        const total = Math.max(1, seed.length - 1);
        const { min, max } = await getAllRounds(tId, 'winner');
        const start = Math.max(1, min || 1);
        const currentMax = Math.max(max, start);

        for (let r = start; r <= currentMax; r++) {
            const curr = await fetchRound(tId, 'winner', r);
            if (curr.length === 0) break;
            const allDone = curr.every((m) => m.status === 'done');
            if (!allDone) return;
            if (r - start + 1 < total) {
                const next = await fetchRound(tId, 'winner', r + 1);
                if (next.length === 0) {
                    await ensurePoolRound(tId, r + 1);
                }
            }
        }
    }

    // ---------- Application d’un vainqueur ----------
    async function applyWinner(m: M, winnerId: string) {
        const loserId = m.player1 === winnerId ? m.player2 : m.player1;

        await supabase.from('matches').update({ winner: winnerId, status: 'done' }).eq('id', m.id);

        const bracket = await isBracketMode(m.tournament_id);
        if (bracket) {
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
        } else {
            // POULE : on débloque le round suivant uniquement quand le courant est terminé
            await ensurePoolProgress(m.tournament_id);
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

        for (const it of items) await applyWinner(it.m, it.winnerId);

        setPending({});
        await load();
    }

    const reset = async (m: M) => {
        await supabase.from('matches').update({ winner: null, status: 'pending' }).eq('id', m.id);
        await load();
    };

    // ---------- Finir le tournoi + Podium ----------
    async function computePodium() {
        const isBracket = await isBracketMode(tournamentId);

        // ===== Bracket
        if (isBracket) {
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
                const lb = (lb3?.[0] as M | undefined);
                if (lb && lb.status === 'done' && lb.winner) {
                    bronze = lb.winner;
                    const opp = lb.winner === lb.player1 ? lb.player2 : lb.player1;
                    fourth = opp || null;
                }
            }

            setPodium({ gold, silver, bronze, fourth });
            return;
        }

        // ===== Poule : classement victoires + éventuel match d’appui
        const totalRounds = await getPoolTotalRounds(tournamentId);

        // Play-off déjà joué ?
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

        // Classement par victoires (winner bracket uniquement)
        const { data: all } = await supabase
            .from('matches')
            .select('winner,status')
            .eq('tournament_id', tournamentId)
            .eq('bracket_type', 'winner');

        const rows: MinimalMatchRow[] = (all || []) as MinimalMatchRow[];
        const wins = new Map<string, number>();
        rows.forEach((mm) => {
            if (mm.status === 'done' && mm.winner) {
                wins.set(mm.winner, (wins.get(mm.winner) || 0) + 1);
            }
        });

        const ordered = [...wins.entries()].sort((a, b) => b[1] - a[1]);
        const first = ordered[0];
        const second = ordered[1];

        if (first && second && first[1] === second[1]) {
            // créer match d’appui si absent
            if (playoff.length === 0) {
                await setPlayersExact(tournamentId, 'winner', totalRounds + 1, 1, first[0], second[0]);
            }
            setPodium({
                note:
                    'Égalité pour la 1ère place : un match d’appui a été créé. Jouez-le puis cliquez à nouveau sur "Finir le tournoi".',
            });
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
                    {'gold' in (podium || {}) && (
                        <div>
                            🥇 1er : <b>{label(podium.gold ?? null)}</b>
                        </div>
                    )}
                    {'silver' in (podium || {}) && (
                        <div>
                            🥈 2e : <b>{label(podium.silver ?? null)}</b>
                        </div>
                    )}
                    {'bronze' in (podium || {}) && (
                        <div>
                            🥉 3e : <b>{label(podium.bronze ?? null)}</b>
                        </div>
                    )}
                    {podium.fourth && (
                        <div>
                            4e : <b>{label(podium.fourth)}</b>
                        </div>
                    )}
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
