/**
 * Number formatters tuned for the trading-terminal look — tabular, padded,
 * sign-prefixed, opt-in monospace.
 */
import { cn } from '@/lib/utils';

export function formatPct(n: number | undefined | null, digits = 1): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const v = n.toFixed(digits);
  return n >= 0 ? `+${v}%` : `${v}%`;
}

export function formatNum(
  n: number | undefined | null,
  digits = 2,
  signed = false,
): string {
  if (n === null || n === undefined || Number.isNaN(n) || !Number.isFinite(n)) return '—';
  const v = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  if (signed) {
    return n >= 0 ? `+${v}` : `−${v}`;
  }
  return n < 0 ? `−${v}` : v;
}

export function formatMoney(
  n: number | undefined | null,
  digits = 2,
  signed = false,
): string {
  if (n === null || n === undefined) return '—';
  return `$${formatNum(Math.abs(n), digits)}${signed && n < 0 ? '' : ''}`;
}

export function formatSignedMoney(n: number | undefined | null, digits = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const sign = n >= 0 ? '+' : '−';
  return `${sign}$${Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

export function formatRatio(n: number | undefined | null, digits = 2): string {
  if (n === null || n === undefined || Number.isNaN(n) || !Number.isFinite(n)) return '∞';
  return n.toFixed(digits);
}

export function Num({
  value,
  digits = 2,
  signed = false,
  className,
}: {
  value?: number | null;
  digits?: number;
  signed?: boolean;
  className?: string;
}) {
  return (
    <span className={cn('font-mono tnum', className)}>
      {formatNum(value, digits, signed)}
    </span>
  );
}
