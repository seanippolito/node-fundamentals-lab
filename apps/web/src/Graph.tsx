import React from "react";

type Point = { t: number; v: number };

function normalize(points: Point[], width: number, height: number, pad = 8) {
    const xs = points.map(p => p.t);
    const ys = points.map(p => p.v);

    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    const xSpan = Math.max(1, maxX - minX);
    const ySpan = Math.max(1, maxY - minY);

    return points.map(p => {
        const x = pad + ((p.t - minX) / xSpan) * (width - pad * 2);
        const y = pad + (1 - (p.v - minY) / ySpan) * (height - pad * 2);
        return { x, y };
    });
}

export function Graph({
                          title,
                          series,
                          width = 520,
                          height = 160,
                          formatValue
                      }: {
    title: string;
    series: { name: string; points: Point[] }[];
    width?: number;
    height?: number;
    formatValue?: (n: number) => string;
}) {
    const lastValues = series.map(s => s.points[s.points.length - 1]?.v).filter(v => typeof v === "number") as number[];
    const last = lastValues.length ? lastValues[0] : 0;

    return (
        <div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <b>{title}</b>
                <span className="small">{formatValue ? formatValue(last) : String(last)}</span>
            </div>

            <svg width={width} height={height} style={{ display: "block", marginTop: 8, border: "1px solid #24243a", borderRadius: 10 }}>
                {/* grid */}
                {Array.from({ length: 5 }).map((_, i) => {
                    const y = (i / 4) * (height - 1);
                    return <line key={i} x1={0} y1={y} x2={width} y2={y} stroke="rgba(255,255,255,0.06)" />;
                })}

                {series.map((s, idx) => {
                    if (s.points.length < 2) return null;
                    const pts = normalize(s.points, width, height);
                    const d = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");
                    return (
                        <path
                            key={s.name}
                            d={d}
                            fill="none"
                            stroke={idx === 0 ? "white" : idx === 1 ? "#9bdcff" : "#a8ff9b"}
                            strokeWidth={2}
                            opacity={0.9}
                        />
                    );
                })}
            </svg>

            <div className="small" style={{ marginTop: 6, display: "flex", gap: 12, flexWrap: "wrap" }}>
                {series.map((s, idx) => (
                    <span key={s.name}>
            <span
                style={{
                    display: "inline-block",
                    width: 10,
                    height: 10,
                    borderRadius: 2,
                    marginRight: 6,
                    background: idx === 0 ? "white" : idx === 1 ? "#9bdcff" : "#a8ff9b"
                }}
            />
                        {s.name}
          </span>
                ))}
            </div>
        </div>
    );
}