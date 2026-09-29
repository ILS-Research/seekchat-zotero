/**
 * Map with an upper bound on entries: get() marks an entry as recently used, set() drops the least recently used
 * entries beyond `max` (except those `keep` protects). Bounds are generous on purpose: they only stop a long Zotero
 * session from keeping the text of every PDF ever opened.
 */
export class LruMap<K, V> {
  private map = new Map<K, V>();

  constructor(private max: number, private keep: (value: V) => boolean = () => false) {}

  get size(): number {
    return this.map.size;
  }

  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size <= this.max) return;
    for (const [k, v] of this.map) {
      if (this.map.size <= this.max) break;
      if (k !== key && !this.keep(v)) this.map.delete(k);
    }
  }

  values(): IterableIterator<V> {
    return this.map.values();
  }

  clear(): void {
    this.map.clear();
  }
}
