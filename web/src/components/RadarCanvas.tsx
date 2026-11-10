// The radar canvas. Drawing stays imperative (Canvas 2D in a requestAnimationFrame loop, only when
// something changed); React just hands it the latest scene and the camera.

import { useEffect, useLayoutEffect, useRef } from "react";
import { worldToPixel } from "../calibration";
import { isTyping } from "../hooks";
import { NO_MAP_TRANSFORM, type Scene, render } from "../render";
import type { View } from "../view";
import s from "./RadarCanvas.module.css";

interface Props {
  /** Camera; owned by the caller so it can centre the map on things. */
  view: View;
  scene: Scene;
  /** Keep the local player centred. */
  follow: boolean;
  /** Dragging the map: the caller turns follow off. */
  onPan: () => void;
  /** Click without drag, in canvas CSS pixels. */
  onTap: (x: number, y: number, view: View) => void;
}

export function RadarCanvas({ view, scene, follow, onPan, onTap }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const latest = useRef({ scene, follow });
  const dirty = useRef(true);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  useLayoutEffect(() => {
    latest.current = { scene, follow };
    dirty.current = true;
  });

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      view.width = canvas.clientWidth;
      view.height = canvas.clientHeight;
      canvas.width = Math.round(view.width * dpr);
      canvas.height = Math.round(view.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      dirty.current = true;
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      view.zoomAt(Math.exp(-e.deltaY * 0.0015), e.offsetX, e.offsetY);
      dirty.current = true;
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });

    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      if (e.key === "+" || e.key === "=") view.zoomAt(1.25, view.width / 2, view.height / 2);
      else if (e.key === "-") view.zoomAt(0.8, view.width / 2, view.height / 2);
      else return;
      dirty.current = true;
    };
    window.addEventListener("keydown", onKey);

    let raf = 0;
    const frame = () => {
      if (dirty.current) {
        dirty.current = false;
        try {
          const { scene, follow } = latest.current;
          const local = scene.players.find((p) => p.local && p.pos);
          if (follow && local?.pos)
            [view.centerU, view.centerV] = worldToPixel(scene.map?.transform ?? NO_MAP_TRANSFORM, local.pos[0], local.pos[2]);
          render(ctx, view, scene);
        } catch (e) {
          console.error("frame failed", e); // keep the loop alive
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      canvas.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
    };
  }, [view]);

  return (
    <canvas
      className={s.radar}
      ref={canvasRef}
      onPointerDown={(e) => {
        drag.current = { x: e.clientX, y: e.clientY, moved: false };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x, dy = e.clientY - d.y;
        if (!d.moved && Math.hypot(dx, dy) < 4) return;
        d.moved = true;
        view.panBy(dx, dy);
        d.x = e.clientX;
        d.y = e.clientY;
        dirty.current = true;
        onPan();
      }}
      onPointerCancel={() => (drag.current = null)}
      onPointerUp={(e) => {
        if (drag.current && !drag.current.moved) onTap(e.nativeEvent.offsetX, e.nativeEvent.offsetY, view);
        drag.current = null;
      }}
    />
  );
}
