'use client';

import { useEffect, useRef } from 'react';

/**
 * Animated gold/amber gradient mesh — simulates floating "guardian"
 * orbs of light against the dark canvas. Pure canvas, no deps.
 */
export function GradientMesh({ className = '' }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const blobs = [
      { x: 0.18, y: 0.32, r: 0.46, hue: 48, alpha: 0.16, vx: 0.00018, vy: 0.00012 },
      { x: 0.78, y: 0.62, r: 0.42, hue: 42, alpha: 0.12, vx: -0.00022, vy: -0.00014 },
      { x: 0.55, y: 0.18, r: 0.32, hue: 38, alpha: 0.08, vx: 0.00012, vy: 0.00020 },
    ];

    function resize() {
      if (!canvas) return;
      const { clientWidth: w, clientHeight: h } = canvas;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
    }
    resize();
    const onResize = () => resize();
    window.addEventListener('resize', onResize);

    let last = performance.now();
    function loop(now: number) {
      if (!canvas || !ctx) return;
      const dt = now - last;
      last = now;

      const W = canvas.width;
      const H = canvas.height;

      ctx.clearRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter';

      for (const b of blobs) {
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        if (b.x < 0.05 || b.x > 0.95) b.vx *= -1;
        if (b.y < 0.05 || b.y > 0.95) b.vy *= -1;
        const cx = b.x * W;
        const cy = b.y * H;
        const r = b.r * Math.max(W, H);
        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        grad.addColorStop(0, `hsla(${b.hue}, 100%, 58%, ${b.alpha})`);
        grad.addColorStop(0.4, `hsla(${b.hue}, 92%, 52%, ${b.alpha * 0.45})`);
        grad.addColorStop(1, 'hsla(40, 0%, 0%, 0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, H);
      }

      ctx.globalCompositeOperation = 'source-over';
      raf = requestAnimationFrame(loop);
    }
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  return (
    <canvas
      ref={ref}
      aria-hidden
      className={`pointer-events-none absolute inset-0 h-full w-full ${className}`}
    />
  );
}
