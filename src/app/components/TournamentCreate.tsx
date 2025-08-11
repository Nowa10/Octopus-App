'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';

type P = {
    id: string;
    first_name: string;
    last_name: string | null;
    belt: string;
    age: number | null;
    weight_kg: number | null;
};

type NewMatch = {
    tournament_id: string;
    round: number;
    slot: number;
    player1: string | null;
    player2: string | null;
    bracket_type?: 'winner' | 'loser';
    status?: 'pending' | 'done' | 'canceled';
};

function genCode() {
    return Math.random().toString(36).slice(2, 8).toUpperCase();
}

export default function TournamentCreate() {
    const [name, setName] = useState('');
    const [q, setQ] = useState('');
    const [people, setPeople] = useState<P[]>([]);
    const [selected, setSelected] = useState<Record<string, boolean>>({});

    // Quick add participant
    const [showAdd, setShowAdd] = useState(false);
    const [addForm, setAddForm] = useState({
        first_name: '',
        last_name: '',
        belt: 'blanche',
        age: '',
        weight_kg: '',
    });
    const [warn, setWarn] = useState<string>('');

    const load = async () => {
        const { data } = await supabase.from('profiles').select('*');
        setPeople(data || []);
    };

    useEffect(() => {
        load();
    }, []);

    const filtered = useMemo(() => {
        const s = q.trim().toLowerCase();
        return people
            .filter(
                (p) =>
                    !s ||
                    `${p.first_name} ${p.last_name || ''} ${p.belt}`
                        .toLowerCase()
                        .includes(s)
            )
            .sort((a, b) => (a.last_name || '').localeCompare(b.last_name || ''));
    }, [people, q]);

    // Vérif doublons basique sur prénom/nom
    useEffect(() => {
        if (!addForm.first_name) {
            setWarn('');
            return;
        }
        const fname = addForm.first_name.trim().toLowerCase();
        const lname = (addForm.last_name || '').trim().toLowerCase();
        const similar = people.filter(
            (p) =>
                p.first_name.toLowerCase() === fname ||
                (lname && (p.last_name || '').toLowerCase() === lname)
        );
        setWarn(
            similar.length
                ? `Existe déjà: ${similar
                    .map((p) => p.first_name + ' ' + (p.last_name || ''))
                    .join(', ')}`
                : ''
        );
    }, [addForm.first_name, addForm.last_name, people]);

    const toggle = (id: string) =>
        setSelected((prev) => ({
            ...prev,
            [id]: !prev[id],
        }));

    const createParticipant = async () => {
        if (!addForm.first_name) return;
        const { data, error } = await supabase
            .from('profiles')
            .insert({
                first_name: addForm.first_name,
                last_name: addForm.last_name || null,
                belt: addForm.belt,
                age: addForm.age ? Number(addForm.age) : null,
                weight_kg: addForm.weight_kg ? Number(addForm.weight_kg) : null,
            })
            .select()
            .single();

        if (error) {
            alert(error.message);
            return;
        }

        setPeople((p) => [...(p || []), data as P]);
        setSelected((s) => ({ ...s, [data.id]: true }));
        setAddForm({
            first_name: '',
            last_name: '',
            belt: 'blanche',
            age: '',
            weight_kg: '',
        });
        setShowAdd(false);
    };

    const createTournament = async () => {
        if (!name) return;
        const code = genCode();

        const { data: t, error } = await supabase
            .from('tournaments')
            .insert({ name, code })
            .select()
            .single();

        if (error) {
            alert(error.message);
            return;
        }

        const ids = Object.keys(selected).filter((id) => selected[id]);

        if (ids.length) {
            await supabase.from('tournament_participants').insert(
                ids.map((pid) => ({
                    tournament_id: t!.id,
                    profile_id: pid,
                }))
            );

            // Mélange joueurs
            const players = people.filter((p) => ids.includes(p.id));
            for (let i = players.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [players[i], players[j]] = [players[j], players[i]];
            }

            // Round 1 (Winner bracket)
            const round1: NewMatch[] = [];
            for (let i = 0; i < players.length; i += 2) {
                round1.push({
                    tournament_id: t!.id,
                    round: 1,
                    slot: i / 2 + 1,
                    player1: players[i]?.id || null,
                    player2: players[i + 1]?.id || null,
                    bracket_type: 'winner',
                    status: 'pending',
                });
            }
            if (round1.length) await supabase.from('matches').insert(round1);
        }

        alert(`Tournoi créé ! Code de gestion: ${code}`);
        window.location.href = `/tournaments/${t!.id}`;
    };

    return (
        <section style={{ display: 'grid', gap: 12 }}>
            <h2>Créer un tournoi</h2>
            <input
                placeholder="Nom du tournoi (ex: -80 kg)"
                value={name}
                onChange={(e) => setName(e.target.value)}
            />

            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                    placeholder="Rechercher participant"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                />
                <button type="button" onClick={() => setShowAdd((v) => !v)}>
                    + Nouveau
                </button>
            </div>

            {showAdd && (
                <div
                    style={{
                        border: '1px solid #eee',
                        padding: 10,
                        borderRadius: 10,
                        display: 'grid',
                        gap: 8,
                    }}
                >
                    <div style={{ fontWeight: 600 }}>Créer un participant</div>
                    <input
                        placeholder="Prénom"
                        value={addForm.first_name}
                        onChange={(e) => setAddForm({ ...addForm, first_name: e.target.value })}
                    />
                    <input
                        placeholder="Nom (optionnel)"
                        value={addForm.last_name}
                        onChange={(e) => setAddForm({ ...addForm, last_name: e.target.value })}
                    />
                    <select
                        value={addForm.belt}
                        onChange={(e) => setAddForm({ ...addForm, belt: e.target.value })}
                    >
                        {['blanche', 'bleue', 'violette', 'marron', 'noire'].map((b) => (
                            <option key={b}>{b}</option>
                        ))}
                    </select>
                    <input
                        placeholder="Âge (optionnel)"
                        type="number"
                        value={addForm.age}
                        onChange={(e) => setAddForm({ ...addForm, age: e.target.value })}
                    />
                    <input
                        placeholder="Poids (kg) (optionnel)"
                        type="number"
                        value={addForm.weight_kg}
                        onChange={(e) => setAddForm({ ...addForm, weight_kg: e.target.value })}
                    />
                    {warn && <div style={{ color: '#b36b00' }}>{warn}</div>}
                    <div style={{ display: 'flex', gap: 8 }}>
                        <button type="button" onClick={createParticipant}>
                            Créer & cocher
                        </button>
                        <button type="button" onClick={() => setShowAdd(false)}>
                            Annuler
                        </button>
                    </div>
                </div>
            )}

            <div
                style={{
                    display: 'grid',
                    gap: 6,
                    maxHeight: 280,
                    overflow: 'auto',
                    border: '1px solid #eee',
                    padding: 8,
                    borderRadius: 8,
                }}
            >
                {filtered.map((p) => (
                    <label
                        key={p.id}
                        style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                    >
                        <input
                            type="checkbox"
                            checked={!!selected[p.id]}
                            onChange={() => toggle(p.id)}
                        />
                        <span>
                            <b>
                                {p.first_name} {p.last_name || ''}
                            </b>{' '}
                            • {p.belt}
                            {p.weight_kg ? ` • ${p.weight_kg} kg` : ''}
                        </span>
                    </label>
                ))}
            </div>

            <button type="button" onClick={createTournament}>
                Lancer le tournoi
            </button>
        </section>
    );
}
