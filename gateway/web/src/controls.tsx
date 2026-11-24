import clsx from 'clsx';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './controls.module.css';

export function Button({ variant = 'primary', className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'outline' | 'ghost' }) {
  return <button {...rest} className={clsx(styles.button, styles[variant], className)} />;
}

/** Label + control stack; the control keeps the native element so form posts work without JS. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className={styles.field}><span className={styles.label}>{label}</span>{children}</label>;
}

export const inputClass = styles.input;

export function ErrorNote({ children }: { children: ReactNode }) {
  return <p className={styles.error} role="alert">{children}</p>;
}
