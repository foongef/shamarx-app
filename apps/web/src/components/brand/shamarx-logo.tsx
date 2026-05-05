import Image from 'next/image';
import { cn } from '@/lib/utils';

type Variant = 'symbol' | 'horizontal' | 'vertical' | 'wordmark';

const SOURCES: Record<Exclude<Variant, 'wordmark'>, string> = {
  symbol: '/logos/shamarx-logo-symbol.png',
  horizontal: '/logos/shamarx-logo-horizontal.png',
  vertical: '/logos/shamarx-logo-vertical.png',
};

const ASPECT: Record<Exclude<Variant, 'wordmark'>, [number, number]> = {
  symbol: [1, 1],
  horizontal: [1600, 480],
  vertical: [1400, 1300],
};

export function ShamarxLogo({
  variant = 'horizontal',
  className,
  height = 28,
  priority = false,
}: {
  variant?: Variant;
  className?: string;
  height?: number;
  priority?: boolean;
}) {
  if (variant === 'wordmark') {
    return (
      <span
        className={cn(
          'display-outline whitespace-nowrap select-none',
          className,
        )}
        style={{ fontSize: height * 0.62 }}
      >
        SHAMAR<span className="text-signal" style={{ WebkitTextStroke: 0 }}>
          X
        </span>
      </span>
    );
  }

  const [aw, ah] = ASPECT[variant];
  const width = Math.round((height * aw) / ah);

  return (
    <Image
      src={SOURCES[variant]}
      alt="Shamarx"
      width={width}
      height={height}
      priority={priority}
      className={cn('object-contain select-none', className)}
      style={{ height }}
    />
  );
}
