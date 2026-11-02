//! Counters for the performance rules of host components and native surfaces.

/// What is counted.
#[derive(Clone, Copy, Debug)]
#[allow(dead_code)]
pub(crate) enum Counter {
    /// Lookups in the host component registry, on either side of the bridge.
    HostRegistryLookups,
    /// Ancestors visited to keep the native-surface counts current. A tree with
    /// no native surface visits none.
    NativeSurfaceWalkNodes,
    /// Bytes of a host component's props copied, serialised or parsed.
    /// Only an `UnsafeMixed` prop read can add to it.
    HostPropsBytesCopied,
    /// Calls to a host component's `update`.
    HostUpdateCalls,
    /// Reports the store's delivery point applied.
    HostReportsDelivered,
}

#[cfg(feature = "test-driver")]
mod enabled {
    use super::Counter;
    use std::sync::atomic::{AtomicU64, Ordering};

    const COUNT: usize = 5;
    static VALUES: [AtomicU64; COUNT] = [
        AtomicU64::new(0),
        AtomicU64::new(0),
        AtomicU64::new(0),
        AtomicU64::new(0),
        AtomicU64::new(0),
    ];

    pub(crate) fn add(counter: Counter, amount: u64) {
        VALUES[counter as usize].fetch_add(amount, Ordering::Relaxed);
    }

    pub(crate) fn read(counter: Counter) -> u64 {
        VALUES[counter as usize].load(Ordering::Relaxed)
    }

    pub(crate) fn reset() {
        for value in &VALUES {
            value.store(0, Ordering::Relaxed);
        }
    }
}

#[cfg(feature = "test-driver")]
pub(crate) use enabled::{read, reset};

/// Adds `amount` to `counter`.
#[cfg(feature = "test-driver")]
#[inline]
pub(crate) fn add(counter: Counter, amount: u64) {
    enabled::add(counter, amount);
}

/// Adds `amount` to `counter`. Nothing without the `test-driver` feature.
#[cfg(not(feature = "test-driver"))]
#[inline(always)]
pub(crate) fn add(_counter: Counter, _amount: u64) {}

/// Counts one occurrence.
#[inline(always)]
pub(crate) fn bump(counter: Counter) {
    add(counter, 1);
}

/// Counts bytes of a host component's props that were copied, for the generated
/// accessor that reads an `UnsafeMixed` prop. Public because generated code in a
/// package calls it.
#[doc(hidden)]
#[inline]
pub fn note_props_bytes_copied(bytes: usize) {
    add(Counter::HostPropsBytesCopied, bytes as u64);
}
