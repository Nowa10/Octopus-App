'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

type P = {
    id: string;
    first_name: string;
    last_name: string | null;
    belt: string;
    age: number | null;
    weight_kg: number | null;
    wins: number | null;
};

export default function ParticipantsPage() {
    const [list, setList] = useState<P[]>([]);
    const [form, setForm] = useState({
        first_name: '',
        last_name: '',
        belt: 'blanche',
        age: '',
        weight_kg: '',
    });

    const load = async () => {
        const { data } = await supabase
            .from('profiles')
            .select('*')
            .order('last_name', { ascending: true });
        setList(data || []);
    };

    useEffect(() => {
        load();
    }, []);

    const add = async (e: any) => {
        e.preventDefault();
        if (!form.first_name) return;
        await supabase.from('profiles').insert({
            first_name: form.first_name,
            last_name: form.last_name || null,
            belt: form.belt,
            age: form.age ? Number(form.age) : null,
            weight_kg: form.weight_kg ? Number(form.weight_kg) : null,
        });
        setForm({
            first_name: '',
            last_name: '',
            belt: 'blanche',
            age: '',
            weight_kg: '',
        });
        load();
    };

    return (
        <main style={{ display: 'grid', gap: 16, padding: 20, maxWidth: 800 }}>
            <h1>Participants</h1>

            <form
                onSubmit={add}
                style={{
                    display: 'grid',
                    gap: 8,
                    border: '1px solid #eee',
                    padding: 12,
                    borderRadius: 10,
                }}
            >
                <input
                    placeholder="Prénom"
                    value={form.first_name}
                    onChange={(e) => setForm({ ...form, first_name: e.target.value })}
                />
                <input
                    placeholder="Nom (optionnel)"
                    value={form.last_name}
                    onChange={(e) => setForm({ ...form, last_name: e.target.value })}
                />
                <select
                    value={form.belt}
                    onChange={(e) => setForm({ ...form, belt: e.target.value })}
                >
                    {['blanche', 'bleue', 'violette', 'marron', 'noire'].map((b) => (
                        <option key={b}>{b}</option>
                    ))}
                </select>
                <input
                    placeholder="Âge (optionnel)"
                    type="number"
                    value={form.age}
                    onChange={(e) => setForm({ ...form, age: e.target.value })}
                />
                <input
                    placeholder="Poids (kg) (optionnel)"
                    type="number"
                    value={form.weight_kg}
                    onChange={(e) => setForm({ ...form, weight_kg: e.target.value })}
                />
                <button type="submit">Ajouter</button>
            </form>

            <div style={{ display: 'grid', gap: 6 }}>
                {list.map((p) => (
                    <div
                        key={p.id}
                        style={{
                            display: 'flex',
                            gap: 8,
                            alignItems: 'center',
                            border: '1px solid #ddd',
                            padding: 8,
                            borderRadius: 8,
                        }}
                    >
                        <div style={{ fontWeight: 600 }}>
                            {p.first_name} {p.last_name || ''}
                        </div>
                        <div>• {p.belt}</div>
                        {p.age != null && <div>• {p.age} ans</div>}
                        {p.weight_kg != null && <div>• {p.weight_kg} kg</div>}
                        <div style={{ marginLeft: 'auto' }}>{p.wins || 0}</div>
                    </div>
                ))}
            </div>
        </main>
    );
}
