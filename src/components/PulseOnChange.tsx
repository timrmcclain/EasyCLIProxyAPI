import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';

const PULSE_MS = 700;

/** True for a moment after `value` changes, never on the first render, so only real changes draw the eye. */
export function useChangePulse(value: string): boolean {
  const previous = useRef(value);
  const [pulsing, setPulsing] = useState(false);
  useEffect(() => {
    if (previous.current === value) return;
    previous.current = value;
    setPulsing(true);
    const timer = window.setTimeout(() => setPulsing(false), PULSE_MS);
    return () => window.clearTimeout(timer);
  }, [value]);
  return pulsing;
}

/** Wraps a status so it pulses once (the shared .status-changed animation) when its state changes. */
export function PulseOnChange({ value, as: Tag = 'span', className, children, ...rest }: {
  value: string;
  as?: 'span' | 'div';
  className?: string;
  children: ReactNode;
} & HTMLAttributes<HTMLElement>) {
  const pulsing = useChangePulse(value);
  return <Tag {...rest} className={[className, pulsing ? 'status-changed' : ''].filter(Boolean).join(' ') || undefined}>{children}</Tag>;
}
