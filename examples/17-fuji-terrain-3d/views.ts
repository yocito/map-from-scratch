// The opening view and the fixed views of the bench. The summit is the
// highest L0 sample of the bake (col 1233, row 1739: 138.72737E 35.36057N,
// 3770.81 m), 4.7 km west and 3.2 km south of the area centre.
import type { Cam } from './terrain.ts';

const SUMMIT_PX = [1233.5, 1739.5];   // L0 px from the area's NW corner (sample centre)
const CELL = 15.578601873;
const sx = (SUMMIT_PX[0] - 1536) * CELL, sy = (1536 - SUMMIT_PX[1]) * CELL;

export const TAU = 1.5;   // refine while a cell is wider than this many px
export const VIEWS: Record<string, Cam> = {
  default: { tx: sx, ty: sy, tz: 1800, yaw: 200, pitch: 28, dist: 40000 },   // from the north, looking SSW
  far: { tx: sx, ty: sy, tz: 1800, yaw: 200, pitch: 30, dist: 60000 },
  close: { tx: sx, ty: sy, tz: 3000, yaw: 200, pitch: 25, dist: 12000 },
  low: { tx: sx, ty: sy, tz: 1800, yaw: 200, pitch: 10, dist: 30000 },
  top: { tx: 0, ty: 0, tz: 800, yaw: 0, pitch: 89, dist: 70000 },
};
