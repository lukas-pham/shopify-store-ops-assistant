/** Small dependency-free SVG chart built only from a tool result (req 4.5). */
export interface Point {
  label: string;
  value: number;
}

export function seriesFrom(data: unknown): Point[] {
  const d = data as Record<string, unknown>;
  if (Array.isArray(d?.byDay)) return (d.byDay as { date: string; sales: number }[]).map((x) => ({ label: x.date.slice(5), value: x.sales }));
  if (Array.isArray(d?.products)) return (d.products as { title: string; units: number }[]).map((x) => ({ label: x.title, value: x.units }));
  if (Array.isArray(d?.items)) return (d.items as { product: string; available: number }[]).slice(0, 12).map((x) => ({ label: x.product, value: x.available }));
  return [];
}

export function Chart({ points, title, kind = "bar" }: { points: Point[]; title: string; kind?: "bar" | "line" }) {
  if (!points.length) return null;
  const W = 640;
  const H = 220;
  const P = 28;
  const max = Math.max(...points.map((p) => p.value), 1);
  const bw = (W - P * 2) / points.length;
  const y = (v: number) => H - P - (v / max) * (H - P * 2);
  const color = "#2c6ecb";
  return (
    <figure style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title} style={{ width: "100%", height: "auto" }}>
        <line x1={P} y1={H - P} x2={W - P} y2={H - P} stroke="#c9cccf" />
        {kind === "bar" ? (
          points.map((p, i) => (
            <g key={i}>
              <rect x={P + i * bw + 3} y={y(p.value)} width={Math.max(bw - 6, 2)} height={H - P - y(p.value)} fill={color} rx={2}>
                <title>{`${p.label}: ${p.value}`}</title>
              </rect>
              {points.length <= 14 && (
                <text x={P + i * bw + bw / 2} y={H - 10} fontSize="10" textAnchor="middle" fill="#616161">
                  {p.label.slice(0, 10)}
                </text>
              )}
            </g>
          ))
        ) : (
          <polyline fill="none" stroke={color} strokeWidth={2} points={points.map((p, i) => `${P + i * bw + bw / 2},${y(p.value)}`).join(" ")} />
        )}
        <text x={P} y={14} fontSize="11" fill="#616161">{`max ${max}`}</text>
      </svg>
      <figcaption style={{ fontSize: 12, color: "#616161" }}>{title}</figcaption>
    </figure>
  );
}
