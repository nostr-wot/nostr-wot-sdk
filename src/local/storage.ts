import type { StorageAdapter } from '../types';
import { StorageError } from '../errors';

/**
 * In-memory storage adapter
 */
export class MemoryStorage implements StorageAdapter {
  private data = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  async clear(): Promise<void> {
    this.data.clear();
  }

  async keys(): Promise<string[]> {
    return Array.from(this.data.keys());
  }
}

/**
 * IndexedDB storage adapter
 */
export class IndexedDBStorage implements StorageAdapter {
  private dbName: string;
  private storeName = 'wot-data';
  private db: IDBDatabase | null = null;
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(dbName = 'nostr-wot-sdk') {
    this.dbName = dbName;
  }

  private async getDB(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new StorageError('open', 'IndexedDB is not available'));
        return;
      }

      const request = indexedDB.open(this.dbName, 1);

      request.onerror = () => {
        reject(new StorageError('open', request.error?.message));
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve(request.result);
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName);
        }
      };
    });

    return this.dbPromise;
  }

  async get(key: string): Promise<string | null> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.storeName, 'readonly');
      const store = transaction.objectStore(this.storeName);
      const request = store.get(key);

      request.onerror = () => {
        reject(new StorageError('get', request.error?.message));
      };

      request.onsuccess = () => {
        resolve(request.result ?? null);
      };
    });
  }

  async set(key: string, value: string): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.storeName, 'readwrite');
      const store = transaction.objectStore(this.storeName);
      const request = store.put(value, key);

      request.onerror = () => {
        reject(new StorageError('set', request.error?.message));
      };

      request.onsuccess = () => {
        resolve();
      };
    });
  }

  async delete(key: string): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.storeName, 'readwrite');
      const store = transaction.objectStore(this.storeName);
      const request = store.delete(key);

      request.onerror = () => {
        reject(new StorageError('delete', request.error?.message));
      };

      request.onsuccess = () => {
        resolve();
      };
    });
  }

  async clear(): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.storeName, 'readwrite');
      const store = transaction.objectStore(this.storeName);
      const request = store.clear();

      request.onerror = () => {
        reject(new StorageError('clear', request.error?.message));
      };

      request.onsuccess = () => {
        resolve();
      };
    });
  }

  async keys(): Promise<string[]> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.storeName, 'readonly');
      const store = transaction.objectStore(this.storeName);
      const request = store.getAllKeys();

      request.onerror = () => {
        reject(new StorageError('keys', request.error?.message));
      };

      request.onsuccess = () => {
        resolve(request.result.map(String));
      };
    });
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.dbPromise = null;
    }
  }
}

/**
 * Creates a storage adapter based on type
 */
export function createStorage(
  type: 'memory' | 'indexeddb' | StorageAdapter
): StorageAdapter {
  if (typeof type === 'object') {
    return type;
  }

  switch (type) {
    case 'indexeddb':
      return new IndexedDBStorage();
    case 'memory':
    default:
      return new MemoryStorage();
  }
}
