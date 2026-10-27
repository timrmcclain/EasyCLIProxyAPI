import { useLayoutEffect, useRef } from 'react';

const prefersReducedMotion = () => typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/**
 * Rows that change place glide from where they were, so you can see what moved instead of the list jumping.
 * Children marked `data-flip-key` are measured each time `order` changes. It uses the Web Animations API, so it
 * never touches inline styles another library (such as drag and drop) owns. `skip` returns true for a change that
 * is already animated, like a drop.
 */
export function useFlipList<T extends HTMLElement>(order: string, skip?: () => boolean) {
  const ref = useRef<T>(null);
  const positions = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const list = ref.current;
    if (!list) return;
    const rows = [...list.querySelectorAll<HTMLElement>(':scope > [data-flip-key]')];
    const next = new Map(rows.map(row => [row.dataset.flipKey ?? '', row.offsetTop]));
    if (positions.current.size && !prefersReducedMotion() && !skip?.()) {
      for (const row of rows) {
        const before = positions.current.get(row.dataset.flipKey ?? '');
        const delta = before === undefined ? 0 : before - row.offsetTop;
        if (Math.abs(delta) > 1) row.animate?.([{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }],
          { duration: 240, easing: 'cubic-bezier(0.2, 0, 0, 1)' });
      }
    }
    positions.current = next;
  }, [order]);
  return ref;
}
