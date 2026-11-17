//! Bounded-concurrency runs that never throw: one result per item, in input order.

use crate::errors::{Error, Result};
use std::future::Future;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tokio_util::sync::CancellationToken;

fn skipped(cancel: Option<&CancellationToken>) -> Error {
    Error::Other(if cancel.is_some_and(CancellationToken::is_cancelled) {
        "Skipped: the call was cancelled.".into()
    } else {
        "Skipped: an earlier operation failed and stop_on_error was true.".into()
    })
}

/// Runs `worker` over `items` with at most `limit` in flight at once, preserving
/// input order in the results. A fixed pool pulls from a shared cursor, so one
/// slow item never stalls a whole chunk.
///
/// `stop_on_error` abandons unstarted work after the first failure; work
/// already in flight is still awaited.
pub async fn map_with_concurrency<T, R, F, Fut>(
    items: Vec<T>,
    limit: usize,
    worker: F,
    stop_on_error: bool,
    cancel: Option<&CancellationToken>,
) -> Vec<Result<R>>
where
    F: Fn(T, usize) -> Fut,
    Fut: Future<Output = Result<R>>,
{
    let count = items.len();
    let pool = limit.min(count).max(1);
    let slots: Mutex<Vec<Option<T>>> = Mutex::new(items.into_iter().map(Some).collect());
    let results: Mutex<Vec<Option<Result<R>>>> = Mutex::new((0..count).map(|_| None).collect());
    let cursor = AtomicUsize::new(0);
    let aborted = AtomicBool::new(false);

    let run_one = || async {
        loop {
            if aborted.load(Ordering::SeqCst) || cancel.is_some_and(CancellationToken::is_cancelled)
            {
                return;
            }
            let index = cursor.fetch_add(1, Ordering::SeqCst);
            if index >= count {
                return;
            }
            let item = slots.lock().map(|mut s| s[index].take()).ok().flatten();
            let Some(item) = item else { return };
            let outcome = worker(item, index).await;
            let failed = outcome.is_err();
            if let Ok(mut r) = results.lock() {
                r[index] = Some(outcome);
            }
            if failed && stop_on_error {
                aborted.store(true, Ordering::SeqCst);
                return;
            }
        }
    };

    futures::future::join_all((0..pool).map(|_| run_one())).await;

    results
        .into_inner()
        .unwrap_or_default()
        .into_iter()
        .map(|r| r.unwrap_or_else(|| Err(skipped(cancel))))
        .collect()
}

/// Runs lanes of work in parallel; items within one lane run one after another
/// (they share a Discord rate-limit bucket, so overlapping them buys nothing).
pub async fn map_lanes<T, R, F, Fut>(
    lanes: Vec<Vec<T>>,
    limit: usize,
    worker: F,
    stop_on_error: bool,
    cancel: Option<&CancellationToken>,
) -> Vec<Vec<Result<R>>>
where
    F: Fn(T) -> Fut,
    Fut: Future<Output = Result<R>>,
{
    let halted = AtomicBool::new(false);
    let sizes: Vec<usize> = lanes.iter().map(Vec::len).collect();

    let run_lane = |lane: Vec<T>, _index: usize| async {
        let mut out = Vec::with_capacity(lane.len());
        for item in lane {
            if halted.load(Ordering::SeqCst) || cancel.is_some_and(CancellationToken::is_cancelled)
            {
                out.push(Err(skipped(cancel)));
                continue;
            }
            let r = worker(item).await;
            if r.is_err() && stop_on_error {
                halted.store(true, Ordering::SeqCst);
            }
            out.push(r);
        }
        Ok::<_, Error>(out)
    };

    let settled = map_with_concurrency(lanes, limit, run_lane, false, None).await;
    settled
        .into_iter()
        .zip(sizes)
        .map(|(r, n)| match r {
            Ok(v) => v,
            Err(e) => (0..n).map(|_| Err(e.clone())).collect(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn keeps_order_and_bounds_concurrency() {
        let live = AtomicUsize::new(0);
        let peak = AtomicUsize::new(0);
        let out = map_with_concurrency(
            (0..10).collect::<Vec<u64>>(),
            3,
            |n, _| {
                let live = &live;
                let peak = &peak;
                async move {
                    let now = live.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(10 - n)).await;
                    live.fetch_sub(1, Ordering::SeqCst);
                    Ok(n * 2)
                }
            },
            false,
            None,
        )
        .await;
        let values: Vec<u64> = out.into_iter().map(|r| r.unwrap()).collect();
        assert_eq!(values, (0..10).map(|n| n * 2).collect::<Vec<_>>());
        assert!(peak.load(Ordering::SeqCst) <= 3);
    }

    #[tokio::test]
    async fn stop_on_error_skips_the_rest() {
        let out = map_with_concurrency(
            vec![1, 2, 3, 4],
            1,
            |n, _| async move {
                if n == 2 {
                    Err(Error::Other("boom".into()))
                } else {
                    Ok(n)
                }
            },
            true,
            None,
        )
        .await;
        assert!(out[0].is_ok());
        assert!(out[1].is_err());
        assert!(
            crate::errors::error_text(out[3].as_ref().unwrap_err())
                .starts_with("Skipped: an earlier operation failed")
        );
    }

    #[tokio::test]
    async fn lanes_run_sequentially_inside() {
        let out = map_lanes(
            vec![vec![1, 2], vec![3]],
            2,
            |n| async move { Ok(n) },
            false,
            None,
        )
        .await;
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].len(), 2);
    }
}
