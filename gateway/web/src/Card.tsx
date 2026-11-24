import type { ReactNode } from 'react';
import { BrandWordmark } from './BrandWordmark.tsx';
import styles from './Card.module.css';

/** Centered single-column surface shared by every standalone page. */
export function Card({ title, children, wide, bare }: { title: string; children: ReactNode; wide?: boolean; bare?: boolean }) {
  return (
    <div className={bare ? `${styles.page} ${styles.bare}` : styles.page}>
      <main className={wide ? `${styles.card} ${styles.wide}` : styles.card}>
        <BrandWordmark size={20} className={styles.brand} />
        <h1 className={styles.title}>{title}</h1>
        {children}
      </main>
    </div>
  );
}
