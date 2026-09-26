/**
 * The editing layer drawn over the preview chart through `renderOverlay`:
 * handles for the selected zone (drag, add at a midpoint, Alt-click removes),
 * and the draw tools (band, rectangle, envelope, polygon).
 */
import { useEffect, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import type { DensityOverlayContext } from "@elabs-ai/components-charts";
import type { DraftZone, Num, Pt } from "./model";

export type Tool = "select" | "band" | "rect" | "envelope" | "line" | "polygon" | "circle" | "quadrant";

export interface DrawResult {
  kind: "band" | "rect" | "envelope" | "line" | "polygon" | "circle" | "quadrant";
  /** Circle: centre and radii. Quadrant: the crossing point is (cx, cy). */
  cx?: number;
  cy?: number;
  rx?: number;
  ry?: number;
  /** Envelope only: the lower edge (the upper one is `pts`), both sorted by x. */
  lower?: Array<[number, number]>;
  x0?: number;
  x1?: number;
  y0?: number;
  y1?: number;
  pts?: [number, number][];
}

interface Props {
  ctx: DensityOverlayContext;
  zone: DraftZone | null;
  color: string;
  tool: Tool;
  snap: boolean;
  /** live change while dragging (`commit` false) and the final one (`commit` true) */
  onChange: (zone: DraftZone, commit: boolean) => void;
  onDraw: (result: DrawResult) => void;
  onCancelDraw: () => void;
  onHover: (text: string | null) => void;
  /** Where an empty quadrant split sits (the axis middle). */
  quadDefault: { x: number; y: number };
}

function niceStep(span: number): number {
  const raw = Math.abs(span) / 100 || 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

const fmt = (v: number) => (Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : (Math.round(v * 100) / 100).toLocaleString());

type HandleRef =
  | { list: "upper" | "lower" | "points" | "line"; i: number }
  | { corner: "tl" | "tr" | "br" | "bl" }
  | { edge: "yMax" | "yMin" }
  | { circle: "c" | "rx" | "ry" }
  | { quad: "c" | "x" | "y" };

export function EditorOverlay({ ctx, zone, color, tool, snap, onChange, onDraw, onCancelDraw, onHover, quadDefault }: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [drawPts, setDrawPts] = useState<[number, number][]>([]);
  const [dragRect, setDragRect] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [cursor, setCursor] = useState<[number, number] | null>(null);
  const dragRef = useRef<{ ref: HandleRef; zone: DraftZone } | null>(null);
  const { box, view } = ctx;
  const sx = niceStep(view.x1 - view.x0);
  const sy = niceStep(view.y1 - view.y0);
  const snapX = (v: number) => (snap ? Math.round(v / sx) * sx : v);
  const snapY = (v: number) => (snap ? Math.round(v / sy) * sy : v);

  useEffect(() => {
    setDrawPts([]);
    setDragRect(null);
  }, [tool]);

  const local = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = svgRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const toData = (e: { clientX: number; clientY: number }): [number, number] => {
    const [px, py] = local(e);
    const [x, y] = ctx.toData(px, py);
    return [snapX(x), snapY(y)];
  };
  const P = (x: number, y: number) => ctx.toPixel(x, y);
  const clampPx = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo - 4000), hi + 4000);

  // ---------- keyboard for draw tools ----------
  useEffect(() => {
    if (tool !== "envelope" && tool !== "polygon" && tool !== "line") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setDrawPts([]);
        onCancelDraw();
      }
      if (e.key === "Enter") {
        // Not a click on whatever button has focus (the tool button itself).
        e.preventDefault();
        e.stopPropagation();
        finishDraw();
      }
      if (e.key === "Backspace" && drawPts.length) {
        e.preventDefault();
        setDrawPts((p) => p.slice(0, -1));
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const finishDraw = () => {
    // A double-click lands two clicks first: drop consecutive duplicates.
    const pts = drawPts.filter((p, i) => i === 0 || Math.hypot(p[0] - drawPts[i - 1]![0], p[1] - drawPts[i - 1]![1]) > 1e-9);
    if (pts.length !== drawPts.length) {
      drawPts.length = 0;
      drawPts.push(...pts);
    }
    if (tool === "line" && drawPts.length >= 2) {
      onDraw({ kind: "line", pts: [...drawPts].sort((a, b) => a[0] - b[0]) });
      setDrawPts([]);
    }
    if (tool === "envelope" && drawPts.length >= 3) {
      const [upper, lower] = splitEnvelope(drawPts);
      onDraw({ kind: "envelope", pts: upper, lower });
      setDrawPts([]);
    }
    if (tool === "polygon" && drawPts.length >= 3) {
      onDraw({ kind: "polygon", pts: drawPts });
      setDrawPts([]);
    }
  };

  // ---------- drawing surface ----------
  const drawing = tool !== "select";
  const onSurfaceDown = (e: RPointerEvent<SVGRectElement>) => {
    if (!drawing || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const [x, y] = toData(e);
    if (tool === "quadrant") {
      onDraw({ kind: "quadrant", cx: x, cy: y });
      return;
    }
    if (tool === "rect" || tool === "band" || tool === "circle") {
      (e.target as Element).setPointerCapture(e.pointerId);
      setDragRect({ x0: x, y0: y, x1: x, y1: y });
      return;
    }
    if ((tool === "polygon" || tool === "envelope") && drawPts.length >= 3) {
      const [fx, fy] = P(drawPts[0]![0], drawPts[0]![1]);
      const [lx, ly] = local(e);
      if (Math.hypot(fx - lx, fy - ly) < 10) {
        finishDraw();
        return;
      }
    }
    setDrawPts((p) => [...p, [x, y]]);
  };
  const onSurfaceMove = (e: RPointerEvent<SVGRectElement>) => {
    if (!drawing) return;
    const [x, y] = toData(e);
    setCursor([x, y]);
    if (dragRect) setDragRect({ ...dragRect, x1: x, y1: y });
    onHover(`x ${fmt(x)} · y ${fmt(y)}`);
  };
  /** A circle drag (centre → edge) as round in PIXELS: radii per axis in data units. */
  const circleOf = (r: { x0: number; y0: number; x1: number; y1: number }) => {
    const [ax, ay] = P(r.x0, r.y0);
    const [bx, by] = P(r.x1, r.y1);
    const rp = Math.hypot(bx - ax, by - ay);
    const [ex] = ctx.toData(ax + rp, ay);
    const [, ey] = ctx.toData(ax, ay - rp);
    // Snap radii to the grid step too (never to 0).
    const rr = (v: number, step: number) => (snap ? Math.max(step, Math.round(v / step) * step) : v);
    return { cx: r.x0, cy: r.y0, rx: rr(Math.abs(ex - r.x0), sx), ry: rr(Math.abs(ey - r.y0), sy), rp };
  };
  const onSurfaceUp = () => {
    if (!dragRect) return;
    const { x0, x1, y0, y1 } = dragRect;
    setDragRect(null);
    if (tool === "circle") {
      const c = circleOf({ x0, x1, y0, y1 });
      if (c.rp < 3) return;
      onDraw({ kind: "circle", cx: c.cx, cy: c.cy, rx: c.rx, ry: c.ry });
      return;
    }
    if (Math.abs(y1 - y0) < 1e-12 && (tool === "band" || Math.abs(x1 - x0) < 1e-12)) return;
    onDraw({ kind: tool as "band" | "rect", x0: Math.min(x0, x1), x1: Math.max(x0, x1), y0: Math.min(y0, y1), y1: Math.max(y0, y1) });
  };

  // ---------- handles ----------
  const setNum = (n: Num, v: number): Num => (n.expr ? n : { v });
  const applyDrag = (z: DraftZone, ref: HandleRef, x: number, y: number): DraftZone => {
    if ("list" in ref) {
      const list = [...z[ref.list]];
      const p = list[ref.i]!;
      list[ref.i] = { x: setNum(p.x, x), y: setNum(p.y, y) };
      return { ...z, [ref.list]: list };
    }
    if ("edge" in ref) return { ...z, [ref.edge]: setNum(z[ref.edge], y) };
    if ("circle" in ref) {
      if (ref.circle === "c") return { ...z, cx: setNum(z.cx, x), cy: setNum(z.cy, y) };
      if (ref.circle === "rx") return { ...z, rx: setNum(z.rx, Math.max(sx, Math.abs(x - (z.cx.v ?? x)))) };
      return { ...z, ry: setNum(z.ry, Math.max(sy, Math.abs(y - (z.cy.v ?? y)))) };
    }
    if ("quad" in ref) {
      return {
        ...z,
        xSplit: ref.quad === "y" ? z.xSplit : setNum(z.xSplit, x),
        ySplit: ref.quad === "x" ? z.ySplit : setNum(z.ySplit, y),
      };
    }
    const c = ref.corner;
    const next = { ...z };
    if (c === "tl" || c === "bl") next.xMin = setNum(z.xMin, x);
    else next.xMax = setNum(z.xMax, x);
    if (c === "tl" || c === "tr") next.yMax = setNum(z.yMax, y);
    else next.yMin = setNum(z.yMin, y);
    return next;
  };
  const onHandleDown = (ref: HandleRef, locked: boolean) => (e: RPointerEvent<SVGCircleElement>) => {
    e.stopPropagation();
    e.preventDefault();
    if (!zone) return;
    if (e.altKey && "list" in ref) {
      const min = ref.list === "points" ? 3 : 2;
      if (zone[ref.list].length > min) {
        const list = zone[ref.list].filter((_, i) => i !== ref.i);
        onChange({ ...zone, [ref.list]: list }, true);
      }
      return;
    }
    if (locked) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    dragRef.current = { ref, zone };
  };
  const onHandleMove = (e: RPointerEvent<SVGCircleElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const [x, y] = toData(e);
    const next = applyDrag(d.zone, d.ref, x, y);
    dragRef.current = { ...d, zone: next };
    onChange(next, false);
    onHover(`x ${fmt(x)} · y ${fmt(y)}`);
  };
  const onHandleUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (d) onChange(d.zone, true);
    onHover(null);
  };
  const addAt = (list: "upper" | "lower" | "points" | "line", i: number, x: number, y: number) => (e: RPointerEvent<SVGCircleElement>) => {
    e.stopPropagation();
    e.preventDefault();
    if (!zone) return;
    const arr = [...zone[list]];
    arr.splice(i, 0, { x: { v: snapX(x) }, y: { v: snapY(y) } });
    onChange({ ...zone, [list]: arr }, true);
  };

  const handles: JSX.Element[] = [];
  const shapes: JSX.Element[] = [];
  const ok = (n: Num) => n.v !== null && Number.isFinite(n.v);
  if (zone && tool === "select") {
    const handle = (key: string, x: number, y: number, ref: HandleRef, lockedX: boolean, lockedY: boolean) => {
      const [hx, hy] = P(x, y);
      const locked = lockedX && lockedY;
      handles.push(
        <circle
          className={locked ? "qhds-ze-handle is-locked" : "qhds-ze-handle"}
          cx={clampPx(hx, box.left, box.left + box.width)}
          cy={clampPx(hy, box.top, box.top + box.height)}
          data-handle={key}
          key={key}
          onPointerDown={onHandleDown(ref, locked)}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          onPointerEnter={() => onHover(`${lockedX || lockedY ? "ƒ " : ""}x ${fmt(x)} · y ${fmt(y)}${locked ? " (expression)" : ""}`)}
          onPointerLeave={() => !dragRef.current && onHover(null)}
          r={6}
          style={{ stroke: color }}
        />,
      );
    };
    const mid = (key: string, a: Pt, b: Pt, list: "upper" | "lower" | "points" | "line", at: number) => {
      if (!ok(a.x) || !ok(a.y) || !ok(b.x) || !ok(b.y)) return;
      const mx = (a.x.v! + b.x.v!) / 2;
      const my = (a.y.v! + b.y.v!) / 2;
      const [px, py] = P(mx, my);
      handles.push(
        <circle
          className="qhds-ze-mid"
          cx={px}
          cy={py}
          data-mid={key}
          key={key}
          onPointerDown={addAt(list, at, mx, my)}
          onPointerEnter={() => onHover("Click to add a point")}
          onPointerLeave={() => onHover(null)}
          r={4}
          style={{ stroke: color }}
        />,
      );
    };
    if (zone.kind === "band" && ok(zone.yMin) && ok(zone.yMax)) {
      const cx = ctx.toData(box.left + box.width / 2, 0)[0];
      handle("yMax", cx, zone.yMax.v!, { edge: "yMax" }, true, !!zone.yMax.expr);
      handle("yMin", cx, zone.yMin.v!, { edge: "yMin" }, true, !!zone.yMin.expr);
    }
    if (zone.kind === "rect" && (zone.extendStart || zone.extendEnd) && ok(zone.yMin) && ok(zone.yMax)) {
      // an endless side has no corner: edge handles at the visible middle instead
      const cx = ctx.toData(box.left + box.width / 2, 0)[0];
      handle("yMax", cx, zone.yMax.v!, { edge: "yMax" }, true, !!zone.yMax.expr);
      handle("yMin", cx, zone.yMin.v!, { edge: "yMin" }, true, !!zone.yMin.expr);
    } else if (zone.kind === "rect" && [zone.xMin, zone.xMax, zone.yMin, zone.yMax].every(ok)) {
      handle("tl", zone.xMin.v!, zone.yMax.v!, { corner: "tl" }, !!zone.xMin.expr, !!zone.yMax.expr);
      handle("tr", zone.xMax.v!, zone.yMax.v!, { corner: "tr" }, !!zone.xMax.expr, !!zone.yMax.expr);
      handle("br", zone.xMax.v!, zone.yMin.v!, { corner: "br" }, !!zone.xMax.expr, !!zone.yMin.expr);
      handle("bl", zone.xMin.v!, zone.yMin.v!, { corner: "bl" }, !!zone.xMin.expr, !!zone.yMin.expr);
    }
    const listHandles = (list: "upper" | "lower" | "points" | "line", closed: boolean) => {
      const arr = zone[list];
      arr.forEach((p, i) => {
        if (ok(p.x) && ok(p.y)) handle(`${list}-${i}`, p.x.v!, p.y.v!, { list, i }, !!p.x.expr, !!p.y.expr);
      });
      for (let i = 0; i + 1 < arr.length; i++) mid(`${list}-m${i}`, arr[i]!, arr[i + 1]!, list, i + 1);
      if (closed && arr.length >= 3) mid(`${list}-m${arr.length - 1}`, arr[arr.length - 1]!, arr[0]!, list, arr.length);
    };
    if (zone.kind === "envelope") {
      listHandles("upper", false);
      if (!zone.mirror) listHandles("lower", false);
      else {
        const ghost = zone.upper.filter((p) => ok(p.x) && ok(p.y)).map((p) => P(p.x.v!, -p.y.v!).join(",")).join(" ");
        shapes.push(<polyline className="qhds-ze-ghost" key="mirror" points={ghost} style={{ stroke: color }} />);
      }
    }
    if (zone.kind === "polygon") listHandles("points", true);
    if (zone.kind === "circle" && [zone.cx, zone.cy, zone.rx, zone.ry].every(ok)) {
      const { cx, cy, rx, ry } = { cx: zone.cx.v!, cy: zone.cy.v!, rx: Math.abs(zone.rx.v!), ry: Math.abs(zone.ry.v!) };
      handle("c", cx, cy, { circle: "c" }, !!zone.cx.expr, !!zone.cy.expr);
      handle("rx", cx + rx, cy, { circle: "rx" }, !!zone.rx.expr, true);
      handle("ry", cx, cy + ry, { circle: "ry" }, true, !!zone.ry.expr);
    }
    if (zone.kind === "quadrant") {
      const qx = ok(zone.xSplit) ? zone.xSplit.v! : quadDefault.x;
      const qy = ok(zone.ySplit) ? zone.ySplit.v! : quadDefault.y;
      const [px, py] = P(qx, qy);
      // the two split lines, dashed, so they read as draggable guides
      shapes.push(
        <line className="qhds-ze-ghost" key="qx" style={{ stroke: color }} x1={px} x2={px} y1={box.top} y2={box.top + box.height} />,
        <line className="qhds-ze-ghost" key="qy" style={{ stroke: color }} x1={box.left} x2={box.left + box.width} y1={py} y2={py} />,
      );
      const [, topY] = ctx.toData(0, box.top + 14);
      const [leftX] = ctx.toData(box.left + 14, 0);
      handle("qc", qx, qy, { quad: "c" }, !!zone.xSplit.expr, !!zone.ySplit.expr);
      handle("qx", qx, topY, { quad: "x" }, !!zone.xSplit.expr, true);
      handle("qy", leftX, qy, { quad: "y" }, true, !!zone.ySplit.expr);
    }
    if (zone.kind === "line") listHandles("line", false);
  }

  // live drawing preview
  if (dragRect && tool === "circle") {
    const c = circleOf(dragRect);
    const [ax, ay] = P(c.cx, c.cy);
    shapes.push(<circle className="qhds-ze-draft" cx={ax} cy={ay} key="draft-circle" r={c.rp} style={{ stroke: color, fill: color }} />);
  } else if (dragRect) {
    const [ax, ay] = P(dragRect.x0, dragRect.y0);
    const [bx, by] = P(dragRect.x1, dragRect.y1);
    const band = tool === "band";
    shapes.push(
      <rect
        className="qhds-ze-draft"
        height={Math.abs(by - ay)}
        key="draft-rect"
        style={{ stroke: color, fill: color }}
        width={band ? box.width : Math.abs(bx - ax)}
        x={band ? box.left : Math.min(ax, bx)}
        y={Math.min(ay, by)}
      />,
    );
  }
  if (tool === "quadrant" && cursor) {
    const [px, py] = P(cursor[0], cursor[1]);
    shapes.push(
      <line className="qhds-ze-draft-line" key="qdx" style={{ stroke: color }} x1={px} x2={px} y1={box.top} y2={box.top + box.height} />,
      <line className="qhds-ze-draft-line" key="qdy" style={{ stroke: color }} x1={box.left} x2={box.left + box.width} y1={py} y2={py} />,
    );
  }
  if (drawPts.length) {
    const ring = (tool === "envelope" || tool === "polygon") && drawPts.length >= 2;
    const all = [...drawPts, ...(cursor ? [cursor] : []), ...(ring ? [drawPts[0]!] : [])];
    const s = all.map(([x, y]) => P(x, y).join(",")).join(" ");
    shapes.push(<polyline className="qhds-ze-draft-line" key="draft-line" points={s} style={{ stroke: color }} />);
    drawPts.forEach(([x, y], i) => {
      const [px, py] = P(x, y);
      const closer = i === 0 && (tool === "polygon" || tool === "envelope") && drawPts.length >= 3;
      shapes.push(
        <circle
          className={closer ? "qhds-ze-handle qhds-ze-closer" : "qhds-ze-handle"}
          cx={px}
          cy={py}
          key={`dp${i}`}
          // The first vertex closes the ring; the others must not swallow clicks
          // meant for the drawing surface underneath.
          onPointerDown={
            closer
              ? (e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  finishDraw();
                }
              : undefined
          }
          r={i === 0 && (tool === "polygon" || tool === "envelope") ? 7 : 5}
          style={{ stroke: color, pointerEvents: closer ? "all" : "none" }}
        />,
      );
    });
  }

  // A visible way to finish (Enter / double-click / clicking the first point
  // all work too, but none of them is discoverable on its own).
  const minPts = tool === "line" ? 2 : 3;
  let finishPill: ReactNode = null;
  if ((tool === "envelope" || tool === "polygon" || tool === "line") && drawPts.length >= minPts) {
    const [lx, ly] = P(drawPts[drawPts.length - 1]![0], drawPts[drawPts.length - 1]![1]);
    const w = 64;
    const fx = Math.min(Math.max(lx + 12, box.left + 4), box.left + box.width - w - 4);
    const fy = Math.min(Math.max(ly - 30, box.top + 4), box.top + box.height - 26);
    finishPill = (
      <g
        className="qhds-ze-finish"
        data-testid="qhds-ze-finish"
        key="finish"
        onPointerDown={(e) => {
          e.stopPropagation();
          e.preventDefault();
          finishDraw();
        }}
        role="button"
        transform={`translate(${fx},${fy})`}
      >
        <rect height={22} rx={11} width={w} />
        <text x={w / 2} y={15}>
          ✓ Finish
        </text>
      </g>
    );
  }

  return (
    <svg className="qhds-ze-overlay" data-tool={tool} ref={svgRef}>
      {drawing ? (
        <rect
          className="qhds-ze-surface"
          data-surface="draw"
          height={box.height}
          onDoubleClick={finishDraw}
          onPointerDown={onSurfaceDown}
          onPointerLeave={() => {
            setCursor(null);
            onHover(null);
          }}
          onPointerMove={onSurfaceMove}
          onPointerUp={onSurfaceUp}
          width={box.width}
          x={box.left}
          y={box.top}
        />
      ) : null}
      {shapes}
      {handles}
      {finishPill}
    </svg>
  );
}

/**
 * A closed outline drawn around a region → the envelope's two edges. The ring
 * is cut at its leftmost and rightmost vertices; the chain with the higher mean
 * y is the upper edge. Each edge is sorted by x (an envelope edge is a function
 * of x), so a slightly back-tracking click order still gives a valid shape.
 */
export function splitEnvelope(ring: Array<[number, number]>): [Array<[number, number]>, Array<[number, number]>] {
  const n = ring.length;
  let li = 0;
  let ri = 0;
  ring.forEach(([x], i) => {
    if (x < ring[li]![0]) li = i;
    if (x > ring[ri]![0]) ri = i;
  });
  const walk = (from: number, to: number, dir: 1 | -1) => {
    const out: Array<[number, number]> = [];
    for (let i = from; ; i = (i + dir + n) % n) {
      out.push(ring[i]!);
      if (i === to) break;
    }
    return out;
  };
  const a = walk(li, ri, 1);
  const b = walk(li, ri, -1);
  const mean = (c: Array<[number, number]>) => c.reduce((s, p) => s + p[1], 0) / c.length;
  const byX = (c: Array<[number, number]>) => [...c].sort((p, q) => p[0] - q[0]);
  // A two-point chain (the straight cut) has the ends only: both edges keep them.
  return mean(a) >= mean(b) ? [byX(a), byX(b)] : [byX(b), byX(a)];
}
