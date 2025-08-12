'use client';
import { ReactNode } from 'react';

export function Card({ title, children }: { title?: ReactNode; children: ReactNode }) {
    return (
        <div className="card fade-in">
            <div className="card__content">
                {title ? <div className="card__title">{title}</div> : null}
                {children}
            </div>
        </div>
    );
}

export function Button({
    children, onClick, variant = 'ghost', size = 'md', disabled,
}: { children: ReactNode; onClick?: () => void; variant?: 'primary' | 'ghost' | 'danger'; size?: 'md' | 'sm'; disabled?: boolean; }) {
    const cls = ['btn', `btn--${variant}`, size === 'sm' ? 'btn--sm' : ''].join(' ');
    return <button className={cls} onClick={onClick} disabled={disabled}>{children}</button>;
}

export function Segment({
    value, onChange, items,
}: { value: string; onChange: (v: string) => void; items: Array<{ label: string; value: string }> }) {
    return (
        <div className="segment">
            {items.map(it => (
                <button key={it.value}
                    className="segment__btn"
                    aria-pressed={value === it.value}
                    onClick={() => onChange(it.value)}
                >
                    {it.label}
                </button>
            ))}
        </div>
    );
}
