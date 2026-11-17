//! Small TTL cache with an LRU bound, used for name -> id resolution.
//!
//! Concurrent misses for one key share a single load. A write or clear while a
//! load is running wins: the load's caller still gets its value, but it is not
//! cached. Loads run as their own task, so a caller that gives up never strands
//! the shared load.

use crate::errors::{Error, Result};
use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

struct Entry<V> {
    value: V,
    expires_at: Instant,
    recency: u64,
}

type Load<V> = Shared<BoxFuture<'static, Result<V>>>;

struct Inner<V> {
    store: HashMap<String, Entry<V>>,
    in_flight: HashMap<String, (u64, Load<V>)>,
    generation: HashMap<String, u64>,
    epoch: u64,
    tick: u64,
    next_load: u64,
}

pub struct TtlCache<V: Clone + Send + Sync + 'static> {
    inner: Arc<Mutex<Inner<V>>>,
    ttl: Duration,
    max_entries: usize,
}

impl<V: Clone + Send + Sync + 'static> TtlCache<V> {
    pub fn new(ttl_ms: u64, max_entries: usize) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                store: HashMap::new(),
                in_flight: HashMap::new(),
                generation: HashMap::new(),
                epoch: 0,
                tick: 0,
                next_load: 0,
            })),
            ttl: Duration::from_millis(ttl_ms),
            max_entries,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner<V>> {
        // A poisoned lock only means a panic elsewhere; the map itself is still consistent.
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    #[cfg(test)]
    pub fn get(&self, key: &str) -> Option<V> {
        let mut inner = self.lock();
        Self::get_locked(&mut inner, key)
    }

    fn get_locked(inner: &mut Inner<V>, key: &str) -> Option<V> {
        let now = Instant::now();
        let expired = inner.store.get(key).is_some_and(|e| e.expires_at <= now);
        if expired {
            inner.store.remove(key);
            return None;
        }
        inner.tick += 1;
        let tick = inner.tick;
        let entry = inner.store.get_mut(key)?;
        entry.recency = tick;
        Some(entry.value.clone())
    }

    pub fn set(&self, key: &str, value: V) {
        let mut inner = self.lock();
        Self::touch(&mut inner, key);
        Self::put(&mut inner, key, value, self.ttl, self.max_entries);
    }

    /// Resolve through the cache, only running `load` on a miss.
    pub async fn fetch<F, Fut>(&self, key: &str, load: F) -> Result<V>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<V>> + Send + 'static,
    {
        let shared = {
            let mut inner = self.lock();
            if let Some(hit) = Self::get_locked(&mut inner, key) {
                return Ok(hit);
            }
            if let Some((_, pending)) = inner.in_flight.get(key) {
                pending.clone()
            } else {
                let generation = inner.generation.get(key).copied().unwrap_or(0);
                let epoch = inner.epoch;
                inner.next_load += 1;
                let load_id = inner.next_load;

                let state = Arc::clone(&self.inner);
                let owned_key = key.to_string();
                let (ttl, max) = (self.ttl, self.max_entries);
                let work = load();
                let task = tokio::spawn(async move {
                    let result = work.await;
                    let mut inner = state
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    if let Ok(value) = &result
                        && inner.generation.get(&owned_key).copied().unwrap_or(0) == generation
                        && inner.epoch == epoch
                    {
                        Self::put(&mut inner, &owned_key, value.clone(), ttl, max);
                    }
                    // A newer load may have replaced this one after an invalidation; only remove our own.
                    if inner
                        .in_flight
                        .get(&owned_key)
                        .is_some_and(|(id, _)| *id == load_id)
                    {
                        inner.in_flight.remove(&owned_key);
                    }
                    result
                });
                let shared: Load<V> = async move {
                    task.await
                        .unwrap_or_else(|e| Err(Error::Other(format!("cache load failed: {e}"))))
                }
                .boxed()
                .shared();
                inner
                    .in_flight
                    .insert(key.to_string(), (load_id, shared.clone()));
                shared
            }
        };
        shared.await
    }

    /// Replaces a cached value in place, keeping its expiry, and only if it is cached.
    pub fn update(&self, key: &str, change: impl FnOnce(&V) -> V) {
        let mut inner = self.lock();
        Self::touch(&mut inner, key);
        let now = Instant::now();
        if let Some(entry) = inner.store.get_mut(key)
            && entry.expires_at > now
        {
            entry.value = change(&entry.value);
        }
    }

    pub fn delete(&self, key: &str) {
        let mut inner = self.lock();
        Self::touch(&mut inner, key);
        inner.store.remove(key);
    }

    pub fn clear(&self) {
        let mut inner = self.lock();
        inner.epoch += 1;
        inner.generation.clear();
        inner.in_flight.clear();
        inner.store.clear();
    }

    #[cfg(test)]
    pub fn size(&self) -> usize {
        self.lock().store.len()
    }

    /// Marks a key as written: any load still running for it is now stale.
    fn touch(inner: &mut Inner<V>, key: &str) {
        *inner.generation.entry(key.to_string()).or_insert(0) += 1;
        inner.in_flight.remove(key);
    }

    fn put(inner: &mut Inner<V>, key: &str, value: V, ttl: Duration, max_entries: usize) {
        // Only a brand-new key can push out another entry.
        if !inner.store.contains_key(key)
            && inner.store.len() >= max_entries
            && let Some(oldest) = inner
                .store
                .iter()
                .min_by_key(|(_, e)| e.recency)
                .map(|(k, _)| k.clone())
        {
            inner.store.remove(&oldest);
        }
        inner.tick += 1;
        let recency = inner.tick;
        inner.store.insert(
            key.to_string(),
            Entry {
                value,
                expires_at: Instant::now() + ttl,
                recency,
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn concurrent_misses_share_one_load() {
        let cache = TtlCache::<u32>::new(60_000, 10);
        let calls = Arc::new(AtomicUsize::new(0));
        let load = || {
            let calls = Arc::clone(&calls);
            async move {
                calls.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(20)).await;
                Ok(7)
            }
        };
        let (a, b) = tokio::join!(cache.fetch("k", load), cache.fetch("k", load));
        assert_eq!((a.unwrap(), b.unwrap()), (7, 7));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(cache.get("k"), Some(7));
    }

    #[tokio::test]
    async fn write_during_load_wins() {
        let cache = Arc::new(TtlCache::<u32>::new(60_000, 10));
        let c2 = Arc::clone(&cache);
        let pending = tokio::spawn(async move {
            c2.fetch("k", || async {
                tokio::time::sleep(Duration::from_millis(30)).await;
                Ok(1)
            })
            .await
        });
        tokio::time::sleep(Duration::from_millis(5)).await;
        cache.set("k", 2);
        assert_eq!(pending.await.unwrap().unwrap(), 1);
        assert_eq!(cache.get("k"), Some(2));
    }

    #[test]
    fn lru_bound_and_update() {
        let cache = TtlCache::<u32>::new(60_000, 2);
        cache.set("a", 1);
        cache.set("b", 2);
        cache.get("a");
        cache.set("c", 3);
        assert_eq!(cache.get("b"), None);
        assert_eq!(cache.size(), 2);
        cache.update("a", |v| v + 10);
        assert_eq!(cache.get("a"), Some(11));
        cache.update("zzz", |v| v + 1);
        assert_eq!(cache.get("zzz"), None);
    }
}
