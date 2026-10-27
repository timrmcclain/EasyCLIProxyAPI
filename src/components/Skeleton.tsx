import './Skeleton.css';

/**
 * A placeholder in the shape of what is loading, so the page doesn't jump when it arrives. The words are still
 * there for screen readers; the shapes are only for the eye.
 */
export function Skeleton({ label, shape = 'line', count = 1, className = '' }: {
  label: string; shape?: 'line' | 'card' | 'bars'; count?: number; className?: string;
}) {
  return (
    <div className={`ui-skeleton ui-skeleton-${shape}${className ? ` ${className}` : ''}`} role="status" aria-busy="true">
      <span className="sr-only">{label}</span>
      {Array.from({ length: count }, (_, index) => <i key={index} aria-hidden="true" />)}
    </div>
  );
}
