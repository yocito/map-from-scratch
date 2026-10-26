// Renderers talk to the harness with one JSON object per line, prefixed by
// "@mfs ". Native renderers print them on stdout; browser renderers pass the
// same objects to window.__mfsEmit (a CDP binding). Events:
//   {"metric": name, "value": x} or {"metric": name, "values": [...]}
//   {"mark": name}        -> harness records <name>_ms with its own clock
//   {"info": {...}}       -> free-form facts (GPU name, vertex count, ...)
//   {"error": message}
//   {"done": true}
const PREFIX = '@mfs ';

export function parseLine(line) {
  if (!line.startsWith(PREFIX)) return null;
  try {
    return JSON.parse(line.slice(PREFIX.length));
  } catch (e) {
    throw new Error(`bad @mfs line: ${line.slice(0, 200)}`);
  }
}

export class Collector {
  constructor() {
    this.metrics = {};
    this.info = {};
    this.errors = [];
    this.done = false;
  }

  push(name, value) {
    (this.metrics[name] ??= []).push(value);
  }

  add(ev, timestampMs) {
    if ('metric' in ev) {
      if (Array.isArray(ev.values)) for (const v of ev.values) this.push(ev.metric, v);
      else this.push(ev.metric, ev.value);
    } else if ('mark' in ev) {
      if (typeof timestampMs !== 'number') throw new Error(`mark ${ev.mark} needs a timestamp`);
      this.push(`${ev.mark}_ms`, timestampMs);
    } else if ('info' in ev) {
      Object.assign(this.info, ev.info);
    } else if ('error' in ev) {
      this.errors.push(String(ev.error));
    } else if ('done' in ev) {
      this.done = true;
    }
  }

  result() {
    return { metrics: this.metrics, info: this.info, errors: this.errors, done: this.done };
  }
}
