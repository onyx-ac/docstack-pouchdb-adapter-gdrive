
/**
 * Simple Least Recently Used (LRU) Cache
 */
export class LRUCache<K, V> {
    private capacity: number;
    private map: Map<K, V>;

    constructor(capacity: number) {
        this.capacity = capacity;
        this.map = new Map();
    }

    get(key: K): V | undefined {
        const value = this.map.get(key);
        if (value !== undefined) {
            // Refresh: delete and re-add to end (most contiguous)
            this.map.delete(key);
            this.map.set(key, value);
        }
        return value;
    }

    put(key: K, value: V): void {
        if (this.map.has(key)) {
            // Update existing
            this.map.delete(key);
        } else if (this.map.size >= this.capacity) {
            // Evict least recently used (first item)
            const firstKey = this.map.keys().next().value;
            if (firstKey !== undefined) {
                this.map.delete(firstKey);
            }
        }
        this.map.set(key, value);
    }

    remove(key: K): void {
        this.map.delete(key);
    }

    clear(): void {
        this.map.clear();
    }
}
