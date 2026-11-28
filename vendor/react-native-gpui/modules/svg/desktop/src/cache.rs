//! The rasters, kept by key in a cache bounded by bytes.
//!
//! One cache for every node, so identical icons share one image. It holds the
//! images strongly: an icon that scrolls off the screen is still here when it
//! comes back. When the total passes the limit the image used longest ago goes
//! first. The limit is 64 MB; `RN_GPUI_SVG_CACHE_MB` sets another.

use crate::key::Key;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

pub const DEFAULT_LIMIT_BYTES: usize = 64 * 1024 * 1024;

struct Entry {
    image: Arc<gpui::RenderImage>,
    bytes: usize,
    used: u64,
}

pub struct Cache {
    limit: usize,
    bytes: usize,
    clock: u64,
    entries: HashMap<Key, Entry>,
}

fn size_of(image: &gpui::RenderImage) -> usize {
    let size = image.size(0);
    size.width.0.max(0) as usize * size.height.0.max(0) as usize * 4
}

impl Cache {
    pub fn new(limit: usize) -> Self {
        Self {
            limit,
            bytes: 0,
            clock: 0,
            entries: HashMap::new(),
        }
    }

    pub fn get(&mut self, key: &Key) -> Option<Arc<gpui::RenderImage>> {
        self.clock += 1;
        let clock = self.clock;
        let entry = self.entries.get_mut(key)?;
        entry.used = clock;
        Some(entry.image.clone())
    }

    pub fn insert(&mut self, key: Key, image: Arc<gpui::RenderImage>) {
        self.clock += 1;
        let bytes = size_of(&image);
        if let Some(old) = self.entries.insert(
            key,
            Entry {
                image,
                bytes,
                used: self.clock,
            },
        ) {
            self.bytes -= old.bytes;
        }
        self.bytes += bytes;
        // The newest image stays even when it alone is over the limit.
        while self.bytes > self.limit && self.entries.len() > 1 {
            let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.used)
                .map(|(key, _)| *key)
            else {
                break;
            };
            if let Some(removed) = self.entries.remove(&oldest) {
                self.bytes -= removed.bytes;
            }
        }
    }

    pub fn bytes(&self) -> usize {
        self.bytes
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }
}

pub fn global() -> &'static Mutex<Cache> {
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    CACHE.get_or_init(|| {
        let limit = std::env::var("RN_GPUI_SVG_CACHE_MB")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .map_or(DEFAULT_LIMIT_BYTES, |megabytes| megabytes * 1024 * 1024);
        Mutex::new(Cache::new(limit))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image(side: u32) -> Arc<gpui::RenderImage> {
        let buffer =
            image::ImageBuffer::from_raw(side, side, vec![0u8; (side * side * 4) as usize])
                .expect("a buffer");
        Arc::new(gpui::RenderImage::new(smallvec::SmallVec::from_const([
            image::Frame::new(buffer),
        ])))
    }

    fn key(n: u64) -> Key {
        crate::key::test_key(n)
    }

    #[test]
    fn it_returns_what_it_was_given_and_counts_bytes() {
        let mut cache = Cache::new(1 << 20);
        let a = image(10);
        cache.insert(key(1), a.clone());
        assert!(Arc::ptr_eq(&cache.get(&key(1)).unwrap(), &a));
        assert!(cache.get(&key(2)).is_none());
        assert_eq!(cache.bytes(), 400);
        // Replacing a key does not count its old image twice.
        cache.insert(key(1), image(20));
        assert_eq!(cache.bytes(), 1600);
        assert_eq!(cache.len(), 1);
    }

    #[test]
    fn it_stays_within_its_limit_and_drops_the_image_used_longest_ago() {
        // Three 10 by 10 images are 1200 bytes; the limit holds two.
        let mut cache = Cache::new(900);
        cache.insert(key(1), image(10));
        cache.insert(key(2), image(10));
        // Using the first makes the second the oldest.
        assert!(cache.get(&key(1)).is_some());
        cache.insert(key(3), image(10));
        assert!(cache.bytes() <= 900);
        assert!(cache.get(&key(1)).is_some());
        assert!(cache.get(&key(2)).is_none());
        assert!(cache.get(&key(3)).is_some());
    }

    #[test]
    fn one_image_over_the_limit_is_still_kept() {
        let mut cache = Cache::new(100);
        cache.insert(key(1), image(10));
        assert_eq!(cache.len(), 1);
        assert!(cache.get(&key(1)).is_some());
        cache.insert(key(2), image(10));
        assert_eq!(cache.len(), 1);
        assert!(cache.get(&key(2)).is_some());
    }
}
