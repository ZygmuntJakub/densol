import { useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { ArrowRight, Package, Github } from "lucide-react";
import { Link } from "react-router-dom";

// ─── Colour palette ────────────────────────────────────────────────────────────
const PALETTE: [number, number, number][] = [
  [74,  222, 128],  // primary green
  [52,  211, 153],  // emerald
  [110, 231, 183],  // mint
  [34,  197,  94],  // deep green
  [163, 230,  53],  // lime
];

const GREEN = "74, 222, 128";

// ─── Hero background canvas ────────────────────────────────────────────────────
//
//  Visual metaphor: raw data arrives as N independent byte-streams from the left.
//  All streams converge into a single "compressor node" (glowing dot at 58% width).
//  Compressed bytes emerge on the right as one fast, small, bright output stream.
//  Burst rings fire each time a byte gets absorbed — mirroring LZ4 match events.
//
const HeroCanvas = () => {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let id: number;
    let tick = 0;

    const resize = () => {
      canvas.width  = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
    };
    resize();
    window.addEventListener("resize", resize);

    // ── Stream config ─────────────────────────────────────────────────────────
    const N_STREAMS   = 11;
    const BYTE_W      = 8;
    const BYTE_H      = 5;
    const SPACING     = 13;            // center-to-center
    const MERGE_FRAC  = 0.22;          // compressor node x position

    const streamYFracs = Array.from({ length: N_STREAMS }, (_, i) =>
      (i + 1) / (N_STREAMS + 1),
    );
    const streamSpeeds = streamYFracs.map(() => 0.9 + Math.random() * 0.7);

    type Byte = { x: number; col: number };

    const streams: Byte[][] = streamYFracs.map(() => {
      const lane: Byte[] = [];
      let x = -(SPACING * Math.floor(Math.random() * 8));
      // Pre-fill up to merge point so streams look full from frame 1
      while (x < 1) { // will be scaled in the frame loop; pre-fill with relative
        lane.push({ x, col: Math.floor(Math.random() * PALETTE.length) });
        x += SPACING;
      }
      return lane;
    });

    // Initialise absolute positions once canvas size is known
    for (let si = 0; si < N_STREAMS; si++) {
      const mergeX = MERGE_FRAC * canvas.width;
      for (const b of streams[si]) b.x = b.x + Math.random() * mergeX * 0.8;
    }

    // ── Output stream ─────────────────────────────────────────────────────────
    type OutByte = { x: number; col: number };
    const output: OutByte[] = [];

    // ── Burst rings ───────────────────────────────────────────────────────────
    type Burst = { r: number; max: number; a: number; cx: number; cy: number };
    const bursts: Burst[] = [];

    // ── Frame loop ────────────────────────────────────────────────────────────
    const frame = () => {
      tick++;
      const w = canvas.width, h = canvas.height;
      const mergeX = MERGE_FRAC * w;
      const mergeY = h * 0.54;

      ctx.clearRect(0, 0, w, h);

      // ── Compressor-node glow ──────────────────────────────────────────────
      const pulse = (Math.sin(tick * 0.045) + 1) / 2;
      for (const [outerR, alpha] of [[90, 0.06], [55, 0.10], [28, 0.16]] as [number, number][]) {
        const g = ctx.createRadialGradient(mergeX, mergeY, 0, mergeX, mergeY, outerR + pulse * 15);
        g.addColorStop(0, `rgba(${GREEN}, ${alpha + pulse * 0.04})`);
        g.addColorStop(1, `rgba(${GREEN}, 0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(mergeX, mergeY, outerR + pulse * 15, 0, Math.PI * 2);
        ctx.fill();
      }
      // Center bright dot
      ctx.shadowBlur = 18; ctx.shadowColor = `rgb(${GREEN})`;
      ctx.fillStyle = `rgba(${GREEN}, ${0.75 + pulse * 0.25})`;
      ctx.beginPath(); ctx.arc(mergeX, mergeY, 4.5, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;

      // ── Funnel guide curves (very subtle) ────────────────────────────────
      for (let si = 0; si < N_STREAMS; si++) {
        const sy = streamYFracs[si] * h;
        ctx.beginPath();
        ctx.moveTo(mergeX - 160, sy);
        ctx.quadraticCurveTo(mergeX - 30, sy, mergeX, mergeY);
        ctx.strokeStyle = "rgba(74, 222, 128, 0.035)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // ── Input streams ─────────────────────────────────────────────────────
      for (let si = 0; si < N_STREAMS; si++) {
        const sy   = streamYFracs[si] * h;
        const spd  = streamSpeeds[si];
        const lane = streams[si];

        // Advance bytes
        for (const b of lane) b.x += spd;

        // Spawn new bytes from left edge
        const leftmost = lane.length ? Math.min(...lane.map(b => b.x)) : SPACING;
        if (leftmost > SPACING) {
          lane.push({
            x:   leftmost - SPACING,
            col: Math.floor(Math.random() * PALETTE.length),
          });
        }

        // Absorb bytes that reach the compressor node
        for (let i = lane.length - 1; i >= 0; i--) {
          if (lane[i].x < mergeX) continue;
          // 15% chance to spawn a burst ring
          if (Math.random() < 0.15) {
            bursts.push({ r: 5, max: 40 + Math.random() * 35, a: 0.55, cx: mergeX, cy: mergeY });
          }
          lane.splice(i, 1);
        }

        // Draw bytes with converge-arc effect
        for (const b of lane) {
          const distToMerge = mergeX - b.x;
          const converging  = distToMerge < 150;
          const cp          = converging ? 1 - distToMerge / 150 : 0; // 0–1

          // Arc toward mergeY as byte enters the funnel
          const drawY = sy + (mergeY - sy) * Math.max(0, cp * 1.4 - 0.4);
          const scale = 1 - cp * 0.45;
          const bw    = BYTE_W * scale, bh = BYTE_H * scale;
          const alpha = 0.28 + cp * 0.38;

          const [r, g, bv] = PALETTE[b.col];

          if (cp > 0.55) {
            ctx.shadowBlur = 6;
            ctx.shadowColor = `rgb(${r},${g},${bv})`;
          }
          ctx.fillStyle = `rgba(${r},${g},${bv},${alpha})`;
          ctx.fillRect(b.x - bw / 2, drawY - bh / 2, bw, bh);
          ctx.shadowBlur = 0;
        }
      }

      // ── Output stream ─────────────────────────────────────────────────────
      if (tick % 5 === 0) {
        output.push({ x: mergeX + 12, col: Math.floor(Math.random() * PALETTE.length) });
      }
      for (let i = output.length - 1; i >= 0; i--) {
        const ob = output[i];
        ob.x += 2.8; // faster than input (compressed → less volume, higher throughput)
        if (ob.x > w + 20) { output.splice(i, 1); continue; }

        const [r, g, bv] = PALETTE[ob.col];
        const outW = BYTE_W * 2.2; // wide — many bytes packed into one
        const outH = BYTE_H * 0.7;

        ctx.shadowBlur = 10; ctx.shadowColor = `rgb(${r},${g},${bv})`;
        ctx.fillStyle = `rgba(${r},${g},${bv}, 0.82)`;
        ctx.fillRect(ob.x - outW / 2, mergeY - outH / 2, outW, outH);
        ctx.shadowBlur = 0;
      }

      // ── Burst rings ───────────────────────────────────────────────────────
      for (let i = bursts.length - 1; i >= 0; i--) {
        const b = bursts[i];
        b.r  += (b.max - b.r) * 0.13;
        b.a  *= 0.87;
        if (b.a < 0.01) { bursts.splice(i, 1); continue; }

        const bg = ctx.createRadialGradient(b.cx, b.cy, b.r * 0.4, b.cx, b.cy, b.r);
        bg.addColorStop(0, `rgba(${GREEN}, ${b.a * 0.5})`);
        bg.addColorStop(1, `rgba(${GREEN}, 0)`);
        ctx.fillStyle = bg;
        ctx.beginPath(); ctx.arc(b.cx, b.cy, b.r, 0, Math.PI * 2); ctx.fill();
      }

      id = requestAnimationFrame(frame);
    };

    frame();
    return () => { cancelAnimationFrame(id); window.removeEventListener("resize", resize); };
  }, []);

  return <canvas ref={ref} aria-hidden="true" className="absolute inset-0 w-full h-full pointer-events-none" />;
};

// ─── Section ───────────────────────────────────────────────────────────────────
export const HeroSection = () => (
  <section
    id="overview"
    className="hero-gradient relative min-h-screen flex items-center px-6 overflow-hidden"
  >
    <HeroCanvas />

    <div className="relative z-10 max-w-3xl mx-auto pt-16">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
      >
        <div className="flex items-center gap-3 mb-8">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full border border-primary/20 bg-primary/5 text-primary text-xs font-mono">
            v0.1 on crates.io
          </span>
        </div>

        <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight leading-[1.1] mb-3">
          On-chain compression
          <br />
          <span className="text-primary">for Solana programs</span>
        </h1>

        <p className="text-lg text-muted-foreground leading-relaxed mb-10">
          One attribute. Store less, pay less rent — zero architecture changes.
        </p>

        <div className="flex flex-wrap items-center gap-4">
          <Link
            to="/docs"
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-primary text-primary-foreground font-medium text-sm transition-all hover:brightness-110"
          >
            Get Started <ArrowRight className="w-4 h-4" />
          </Link>
          <a
            href="https://github.com/ZygmuntJakub/densol"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg border border-border text-foreground font-medium text-sm transition-all hover:bg-secondary"
          >
            <Github className="w-4 h-4" /> GitHub
          </a>
          <a
            href="https://crates.io/crates/densol"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg border border-border text-foreground font-medium text-sm transition-all hover:bg-secondary"
          >
            <Package className="w-4 h-4" /> crates.io
          </a>
        </div>
      </motion.div>
      {/* Add some space */}
      <div className="h-[73px]" />
    </div>
  </section>
);
