#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const RESULTS_DIR = path.resolve(__dirname, "..", "results");
const FINDINGS_PATH = path.resolve(__dirname, "..", "FINDINGS.md");

const ALL_MODE = process.argv.includes("--all");

// ─── Color palette — readable on both light & dark GitHub themes ─────
const COLORS = {
  repetitive:  "#4e79a7",
  "json-like": "#59a14f",
  random:      "#e15759",
  lz4:         "#4e79a7",
  rle:         "#f28e2b",
  identity:    "#76b7b2",
};
const STROKE_DASH = {
  raw:    "",
  comp:   "6,3",
  decomp: "2,2",
};

// ─── Helpers ─────────────────────────────────────────────────────────

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function fmt(n) {
  if (n == null || n === "N/A" || n === "OOM") return String(n ?? "—");
  return Number(n).toLocaleString("en-US");
}

function fmtSize(bytes) {
  if (bytes >= 1024) return (bytes / 1024) + " KB";
  return bytes + " B";
}

function fmtCompact(n) {
  if (n == null) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "K";
  return String(n);
}

function escXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─── Numeric helpers ─────────────────────────────────────────────────

function ceilNice(max) {
  if (max <= 0) return 10;
  const mag = Math.pow(10, Math.floor(Math.log10(max)));
  const norm = max / mag;
  if (norm <= 1) return mag;
  if (norm <= 2) return 2 * mag;
  if (norm <= 5) return 5 * mag;
  return 10 * mag;
}

function genTicks(max, count) {
  const step = max / count;
  return Array.from({ length: count + 1 }, (_, i) => Math.round(step * i));
}

// ─── SVG primitives ──────────────────────────────────────────────────

function svgOpen(width, height) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
<style>
  text { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; fill: #444; }
  .title { font-size: 14px; font-weight: 600; fill: #222; }
  .axis-label { font-size: 11px; fill: #666; }
  .tick-label { font-size: 10px; fill: #888; }
  .legend-label { font-size: 11px; fill: #555; }
  .grid { stroke: #e8e8e8; stroke-width: 1; }
  .axis { stroke: #bbb; stroke-width: 1; }
  .data-label { font-size: 9px; fill: #555; }
</style>`;
}

function text(x, y, str, cls, opts = {}) {
  const anchor = opts.anchor || "middle";
  const extra = opts.transform ? ` transform="${opts.transform}"` : "";
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" class="${cls}"${extra}>${escXml(str)}</text>`;
}

function rect(x, y, w, h, fill, rx = 3) {
  if (w < 0.5 || h < 0.5) return "";
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" rx="${rx}"/>`;
}

function line(x1, y1, x2, y2, cls = "grid") {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="${cls}"/>`;
}

function polyline(points, color, dash = "") {
  const d = dash ? ` stroke-dasharray="${dash}"` : "";
  return `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="2.5"${d}/>`;
}

function circle(cx, cy, r, color) {
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}"/>`;
}

// ─── Reusable line chart ─────────────────────────────────────────────

function buildLineChart({ title, xTicks, series, xLabel, yLabel, width = 700, height = 360, logX = false }) {
  const M = { top: 44, right: 24, bottom: 72, left: 72 };
  const pw = width - M.left - M.right;
  const ph = height - M.top - M.bottom;

  const allY = series.flatMap(s => s.values.filter(v => v != null));
  const niceY = ceilNice(Math.max(...allY, 1));
  const yTicks = genTicks(niceY, 5);

  let scaleX;
  if (logX) {
    const logMin = Math.log10(Math.max(xTicks[0], 1));
    const logMax = Math.log10(xTicks[xTicks.length - 1]);
    scaleX = v => M.left + ((Math.log10(Math.max(v, 1)) - logMin) / (logMax - logMin)) * pw;
  } else {
    const xMin = xTicks[0], xMax = xTicks[xTicks.length - 1];
    scaleX = v => M.left + ((v - xMin) / (xMax - xMin)) * pw;
  }
  const scaleY = v => M.top + ph - (v / niceY) * ph;

  const p = [];
  p.push(svgOpen(width, height));

  // Grid + y-axis ticks
  for (const t of yTicks) {
    const y = scaleY(t);
    p.push(line(M.left, y, M.left + pw, y));
    p.push(text(M.left - 8, y + 4, fmtCompact(t), "tick-label", { anchor: "end" }));
  }

  // Axes
  p.push(line(M.left, M.top, M.left, M.top + ph, "axis"));
  p.push(line(M.left, M.top + ph, M.left + pw, M.top + ph, "axis"));

  // X-axis ticks
  for (const xv of xTicks) {
    const x = scaleX(xv);
    p.push(line(x, M.top + ph, x, M.top + ph + 4, "axis"));
    p.push(text(x, M.top + ph + 18, fmtSize(xv), "tick-label"));
  }

  // Data lines + dots
  for (const s of series) {
    const pts = [];
    for (let i = 0; i < xTicks.length; i++) {
      if (s.values[i] == null) continue;
      pts.push(`${scaleX(xTicks[i]).toFixed(1)},${scaleY(s.values[i]).toFixed(1)}`);
    }
    if (pts.length > 1) p.push(polyline(pts.join(" "), s.color, s.dash || ""));
    for (let i = 0; i < xTicks.length; i++) {
      if (s.values[i] == null) continue;
      p.push(circle(scaleX(xTicks[i]), scaleY(s.values[i]), 4, s.color));
    }
  }

  // Legend (horizontal, bottom)
  let lx = M.left;
  const ly = height - 12;
  for (const s of series) {
    p.push(rect(lx, ly - 9, 12, 12, s.color, 2));
    p.push(text(lx + 16, ly + 1, s.name, "legend-label", { anchor: "start" }));
    lx += s.name.length * 7 + 30;
  }

  // Title + axis labels
  p.push(text(width / 2, 24, title, "title"));
  p.push(text(14, M.top + ph / 2, yLabel, "axis-label", { transform: `rotate(-90,14,${M.top + ph / 2})` }));
  p.push(text(M.left + pw / 2, M.top + ph + 44, xLabel, "axis-label"));

  p.push("</svg>");
  return p.join("\n");
}

// ─── Reusable grouped bar chart ──────────────────────────────────────

function buildBarChart({ title, groups, series, yLabel, width = 700, height = 360, rotateLabels = false }) {
  const M = { top: 44, right: 24, bottom: rotateLabels ? 90 : 64, left: 72 };
  const pw = width - M.left - M.right;
  const ph = height - M.top - M.bottom;

  const allY = series.flatMap(s => s.values.filter(v => v != null));
  const niceY = ceilNice(Math.max(...allY, 1));
  const yTicks = genTicks(niceY, 5);

  const nG = groups.length;
  const nS = series.length;
  const groupW = pw / nG;
  const gap = Math.max(groupW * 0.15, 4);
  const barTotalW = groupW - gap;
  const barW = Math.min(barTotalW / nS, 40);
  const barGroupW = barW * nS;
  const barOff = (groupW - barGroupW) / 2;

  const scaleY = v => M.top + ph - (v / niceY) * ph;

  const p = [];
  p.push(svgOpen(width, height));

  // Grid + y-axis ticks
  for (const t of yTicks) {
    const y = scaleY(t);
    p.push(line(M.left, y, M.left + pw, y));
    p.push(text(M.left - 8, y + 4, fmtCompact(t), "tick-label", { anchor: "end" }));
  }

  // Axes
  p.push(line(M.left, M.top, M.left, M.top + ph, "axis"));
  p.push(line(M.left, M.top + ph, M.left + pw, M.top + ph, "axis"));

  // Bars + x labels
  for (let g = 0; g < nG; g++) {
    const gx = M.left + g * groupW;
    const labelX = gx + groupW / 2;

    if (rotateLabels) {
      p.push(text(labelX, M.top + ph + 12, groups[g], "tick-label", {
        anchor: "end",
        transform: `rotate(-40,${labelX},${M.top + ph + 12})`,
      }));
    } else {
      p.push(text(labelX, M.top + ph + 18, groups[g], "tick-label"));
    }

    for (let s = 0; s < nS; s++) {
      const val = series[s].values[g];
      if (val == null || val <= 0) continue;
      const barH = (val / niceY) * ph;
      const x = gx + barOff + s * barW;
      const y = M.top + ph - barH;
      p.push(rect(x, y, barW - 2, barH, series[s].color));

      if (nG <= 8) {
        p.push(text(x + (barW - 2) / 2, y - 4, fmtCompact(val), "data-label"));
      }
    }
  }

  // Legend
  let lx = M.left;
  const ly = height - 12;
  for (const s of series) {
    p.push(rect(lx, ly - 9, 12, 12, s.color, 2));
    p.push(text(lx + 16, ly + 1, s.name, "legend-label", { anchor: "start" }));
    lx += s.name.length * 7 + 30;
  }

  p.push(text(width / 2, 24, title, "title"));
  p.push(text(14, M.top + ph / 2, yLabel, "axis-label", { transform: `rotate(-90,14,${M.top + ph / 2})` }));

  p.push("</svg>");
  return p.join("\n");
}

// ─── Chart builders (domain-specific) ────────────────────────────────

function chartCompressionRatio(data) {
  const byType = groupByType(data.rows);
  const sizes = uniqueSizes(data.rows);
  const series = Object.keys(byType).map(t => ({
    name: t,
    color: COLORS[t] || "#999",
    values: sizes.map(sz => {
      const r = byType[t].find(r => r.size === sz);
      return r && r.ratio && r.ratio !== "N/A" ? parseFloat(r.ratio) : null;
    }),
  }));
  return buildLineChart({
    title: `Compression Ratio — ${data.strategy.toUpperCase()}`,
    xTicks: sizes, series,
    xLabel: "Data size",
    yLabel: "Compression ratio (×)",
    logX: true,
  });
}

function chartWriteCu(data) {
  const byType = groupByType(data.rows);
  const sizes = uniqueSizes(data.rows);
  const series = [];
  for (const t of ["repetitive", "json-like", "random"]) {
    if (!byType[t]) continue;
    series.push({
      name: `${t} raw O(N)`,
      color: COLORS[t],
      dash: "6,3",
      values: sizes.map(sz => byType[t].find(r => r.size === sz)?.rawCu ?? null),
    });
    series.push({
      name: `${t} compress+write`,
      color: COLORS[t],
      dash: "",
      values: sizes.map(sz => byType[t].find(r => r.size === sz)?.writeCompCu ?? null),
    });
  }
  return buildLineChart({
    title: "Raw O(N) CU vs Compress+Write CU",
    xTicks: sizes, series,
    xLabel: "Data size",
    yLabel: "Compute Units",
    logX: true,
  });
}

function chartRentSavings(data) {
  const sizes = uniqueSizes(data.rows);
  const byType = groupByType(data.rows);
  const types = ["repetitive", "json-like"].filter(t => byType[t]);
  const series = types.map(t => ({
    name: t,
    color: COLORS[t],
    values: sizes.map(sz => {
      const r = byType[t].find(r => r.size === sz);
      if (!r) return null;
      const v = typeof r.rentSavings === "string"
        ? parseInt(r.rentSavings.replace(/[^0-9-]/g, ""), 10)
        : r.rentSavings;
      return v > 0 ? v : null;
    }),
  }));
  const sizeLabels = sizes.map(fmtSize);
  return buildBarChart({
    title: "Rent Savings per Account",
    groups: sizeLabels, series,
    yLabel: "Rent saved (µLamports)",
  });
}

function chartStrategyComparison(allData) {
  const targetSize = 10240;
  const targetType = "repetitive";
  const strats = allData.map(d => d.strategy.toUpperCase());
  const compCu = allData.map(d => {
    const r = d.rows.find(r => r.label === targetType && r.size === targetSize);
    return r?.writeCompCu ?? null;
  });
  const decompCu = allData.map(d => {
    const r = d.rows.find(r => r.label === targetType && r.size === targetSize);
    return r?.decompCu ?? null;
  });
  return buildBarChart({
    title: `Strategy Comparison — ${targetType} 10 KB`,
    groups: strats,
    series: [
      { name: "write+comp CU", color: "#4e79a7", values: compCu },
      { name: "decomp CU", color: "#e15759", values: decompCu },
    ],
    yLabel: "Compute Units",
  });
}

// ─── Data helpers ────────────────────────────────────────────────────

function groupByType(rows) {
  const out = {};
  for (const r of rows) {
    (out[r.label] ||= []).push(r);
  }
  return out;
}

function uniqueSizes(rows) {
  return [...new Set(rows.map(r => r.size))].sort((a, b) => a - b);
}

// ─── Markdown table generation ───────────────────────────────────────

function totalCuTable(rows) {
  const header = "| data-type | orig | comp | ratio | raw CU | write+comp CU | decomp CU | rent+save (µL) | break-even |";
  const align  = "|-----------|-----:|-----:|------:|-------:|--------------:|----------:|---------------:|-----------:|";
  const body = rows.map(r => {
    const ratio = r.ratio ? r.ratio + "×" : "—";
    return `| ${r.label} | ${fmt(r.size)} | ${r.compSize != null ? fmt(r.compSize) : "—"} | ${ratio} | ${fmt(r.rawCu)} | ${r.writeCompCu != null ? fmt(r.writeCompCu) : "OOM"} | ${r.decompCu != null ? fmt(r.decompCu) : "OOM"} | ${fmt(r.rentSavings)} | ${r.breakEven} |`;
  });
  return [header, align, ...body].join("\n");
}

function netCuTable(rows) {
  const header = "| data-type | orig | comp | ratio | net cksum | net write+comp | net decomp |";
  const align  = "|-----------|-----:|-----:|------:|----------:|---------------:|-----------:|";
  const body = rows.map(r => {
    const ratio = r.ratio ? r.ratio + "×" : "—";
    return `| ${r.label} | ${fmt(r.size)} | ${r.compSize != null ? fmt(r.compSize) : "—"} | ${ratio} | ${fmt(r.netRawCu)} | ${r.netWriteCompCu != null ? fmt(r.netWriteCompCu) : "OOM"} | ${r.netDecompCu != null ? fmt(r.netDecompCu) : "OOM"} |`;
  });
  return [header, align, ...body].join("\n");
}

function strategyComparisonTable(allData) {
  const header = "| strategy | data-type | orig | comp | ratio | write+comp CU | decomp CU |";
  const align  = "|----------|-----------|-----:|-----:|------:|--------------:|----------:|";
  const body = [];
  for (const d of allData) {
    for (const r of d.rows) {
      const ratio = r.ratio ? r.ratio + "×" : "—";
      body.push(`| ${d.strategy} | ${r.label} | ${fmt(r.size)} | ${r.compSize != null ? fmt(r.compSize) : "—"} | ${ratio} | ${r.writeCompCu != null ? fmt(r.writeCompCu) : "OOM"} | ${r.decompCu != null ? fmt(r.decompCu) : "OOM"} |`);
    }
  }
  return [header, align, ...body].join("\n");
}

// ─── FINDINGS.md injection ───────────────────────────────────────────

function inject(content, marker, replacement) {
  const begin = `<!-- BEGIN ${marker} -->`;
  const end = `<!-- END ${marker} -->`;
  const re = new RegExp(`${escRegex(begin)}[\\s\\S]*?${escRegex(end)}`, "m");
  if (!re.test(content)) {
    console.warn(`  Warning: marker ${marker} not found in FINDINGS.md — skipping`);
    return content;
  }
  return content.replace(re, `${begin}\n${replacement}\n${end}`);
}

function escRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Main ────────────────────────────────────────────────────────────

function main() {
  const jsonFiles = fs.readdirSync(RESULTS_DIR)
    .filter(f => f.startsWith("benchmark-") && f.endsWith(".json"))
    .sort();

  if (jsonFiles.length === 0) {
    console.error("No benchmark JSON files found in results/. Run `anchor test` first.");
    process.exit(1);
  }

  const allData = jsonFiles.map(f => loadJson(path.join(RESULTS_DIR, f)));
  const primary = allData.find(d => d.strategy === "lz4") || allData[0];

  console.log(`Loaded ${allData.length} benchmark file(s): ${jsonFiles.join(", ")}`);

  fs.writeFileSync(path.join(RESULTS_DIR, "compression-ratio.svg"), chartCompressionRatio(primary));
  console.log("  -> compression-ratio.svg");

  fs.writeFileSync(path.join(RESULTS_DIR, "write-cu.svg"), chartWriteCu(primary));
  console.log("  -> write-cu.svg");

  fs.writeFileSync(path.join(RESULTS_DIR, "rent-savings.svg"), chartRentSavings(primary));
  console.log("  -> rent-savings.svg");

  if (ALL_MODE && allData.length > 1) {
    fs.writeFileSync(path.join(RESULTS_DIR, "strategy-comparison.svg"), chartStrategyComparison(allData));
    console.log("  -> strategy-comparison.svg");
  }

  if (fs.existsSync(FINDINGS_PATH)) {
    let content = fs.readFileSync(FINDINGS_PATH, "utf8");
    content = inject(content, "TOTAL_CU", totalCuTable(primary.rows));
    content = inject(content, "NET_CU", netCuTable(primary.rows));
    if (ALL_MODE && allData.length > 1) {
      content = inject(content, "STRATEGY_COMPARISON", strategyComparisonTable(allData));
    }
    fs.writeFileSync(FINDINGS_PATH, content);
    console.log("  -> FINDINGS.md tables updated");
  } else {
    console.warn("  FINDINGS.md not found — skipping table injection");
  }

  console.log("Done.");
}

main();
