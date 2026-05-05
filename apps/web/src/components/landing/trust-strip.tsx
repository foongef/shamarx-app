'use client';

import { ScrollMarquee } from './scroll-marquee';

export function TrustStrip() {
  return (
    <section id="trust" aria-label="Brand principles" className="relative border-y border-border/60 bg-card/30 py-7">
      <ScrollMarquee
        items={[
          'Guarded by Design',
          'Precision in Every Trade',
          'Discipline over Hype',
          'Capital Protection First',
          'Quiet Confidence',
          'Always Watching',
        ]}
      />
    </section>
  );
}
