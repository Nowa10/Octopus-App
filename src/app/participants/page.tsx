'use client';

import { useEffect, useState, FormEvent } from 'react';
import { supabase } from '@/lib/supabase';
import { Button, Card } from '@/app/components/ui';

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
    const [form, setForm] = useState({ first_name: '', last_name: '', belt: 'blanche', age: '', weight_kg: '' });

    const load = async () => {
        const { data } = await supabase.from('profiles').select('*').order('last_name', { ascending: true });
        setList(data || []);
    };

    useEffect(() => { load(); }, []);

    const add = async (e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        if (!form.first_name) return;
        await supabase.from('profiles').insert({
            first_name: form.first_name,
            last_name: form.last_name || null,
            belt: form.belt,
            age: form.age ? Number(form.age) : null,
            weight_kg: form.weight_kg ? Number(form.weight_kg) : null,
        });
        setForm({ first_name: '', last_name: '', belt: 'blanche', age: '', weight_kg: '' });
        load();
    };

    return (
        <>
            <h1 className="section-title">Participants</h1>

            <Card title="Ajouter un participant">
                <form onSubmit={add} className="stack">
                    <input className="input" placeholder="Prénom" value={form.first_name}
                        onChange={(e) => setForm({ ...form, first_name: e.target.value })} />
                    <input className="input" placeholder="Nom (optionnel)" value={form.last_name}
                        onChange={(e) => setForm({ ...form, last_name: e.target.value })} />
                    <select className="select" value={form.belt} onChange={(e) => setForm({ ...form, belt: e.target.value })}>
                        {['blanche', 'bleue', 'violette', 'marron', 'noire'].map((b) => <option key={b}>{b}</option>)}
                    </select>
                    <input className="input" placeholder="Âge (optionnel)" type="number" value={form.age}
                        onChange={(e) => setForm({ ...form, age: e.target.value })} />
                    <input className="input" placeholder="Poids (kg) (optionnel)" type="number" value={form.weight_kg}
                        onChange={(e) => setForm({ ...form, weight_kg: e.target.value })} />
                    <div className="hstack">
                        <span className="spacer" />
                        <button className="btn btn-primary" type="submit">Ajouter</button>
                    </div>
                </form>
            </Card>

            <Card title="Liste">
                <div className="stack">
                    {list.map((p) => (
                        <div key={p.id} className="matchline">
                            <div style={{ fontWeight: 600 }}>
                                {p.first_name} {p.last_name || ''}
                            </div>
                            <div style={{ opacity: .8 }}>
                                {p.belt}
                                {p.age != null && <> • {p.age} ans</>}
                                {p.weight_kg != null && <> • {p.weight_kg} kg</>}
                            </div>
                            <div style={{ marginLeft: 'auto', fontWeight: 700 }}>{p.wins || 0}</div>
                        </div>
                    ))}
                </div>
            </Card>
        </>
    );
}
