import type { MfsEvent, RawResult, CheckRun } from './types.ts';

// Renderers talk to the harness with one JSON object per line, prefixed by
// "@mfs ". Native renderers print them on stdout; browser renderers pass the
// same objects to window.__mfsEmit (a CDP binding). Events:
//   {"metric": name, "value": x} or {"metric": name, "values": [...]}
//   {"mark": name}        -> harness records <name>_ms with its own clock
//   {"info": {...}}       -> free-form facts (GPU name, vertex count, ...)
//   {"check": id, "pass": bool, "detail": text}  -> a verification check of spec.yaml
//   {"error": message}
//   {"done": true}
const PREFIX = '@mfs ';

export function parseLine(line: string): MfsEvent | null {
  if (!line.startsWith(PREFIX)) return null;
  try {
    return JSON.parse(line.slice(PREFIX.length)) as MfsEvent;
  } catch {
    throw new Error(`bad @mfs line: ${line.slice(0, 200)}`);
  }
}

export class Collector {
  metrics: Record<string, number[]> = {};
  info: Record<string, unknown> = {};
  errors: string[] = [];
  checks: Record<string, CheckRun[]> = {};
  done = false;

  push(name: string, value: number): void {
    (this.metrics[name] ??= []).push(value);
  }

  add(ev: MfsEvent, timestampMs?: number): void {
    if ('metric' in ev) {
      if (Array.isArray(ev.values)) for (const v of ev.values) this.push(ev.metric, v);
      else if (typeof ev.value === 'number') this.push(ev.metric, ev.value);
    } else if ('mark' in ev) {
      if (typeof timestampMs !== 'number') throw new Error(`mark ${ev.mark} needs a timestamp`);
      this.push(`${ev.mark}_ms`, timestampMs);
    } else if ('info' in ev) {
      Object.assign(this.info, ev.info);
    } else if ('check' in ev) {
      (this.checks[ev.check] ??= []).push({ pass: ev.pass === true, detail: ev.detail });
    } else if ('error' in ev) {
      this.errors.push(String(ev.error));
    } else if ('done' in ev) {
      this.done = true;
    }
  }

  result(): RawResult {
    return { metrics: this.metrics, info: this.info, errors: this.errors, checks: this.checks, done: this.done };
  }
}
