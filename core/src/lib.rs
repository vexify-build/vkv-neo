//! vkv-neo core engine — shared by the WASM and N-API (native) backends.
//! Powered By Vexify.

use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};

/// Fast, small, deterministic hasher (FxHash-style).
/// No external RNG needed, so it behaves identically on JS/WASM/native.
#[derive(Default)]
pub struct FxHasher {
    hash: u64,
}

impl Hasher for FxHasher {
    #[inline]
    fn finish(&self) -> u64 {
        self.hash
    }

    #[inline]
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.hash = (self.hash.rotate_left(5) ^ u64::from(b)).wrapping_mul(0x517c_c1b7_2722_0a95);
        }
    }
}

type Build = BuildHasherDefault<FxHasher>;

const MISSING: u32 = u32::MAX;

/// In-memory binary-safe key-value store.
pub struct Vkv {
    inner: HashMap<Vec<u8>, Vec<u8>, Build>,
}

impl Default for Vkv {
    fn default() -> Self {
        Self::new()
    }
}

impl Vkv {
    pub fn new() -> Self {
        Vkv {
            inner: HashMap::with_hasher(BuildHasherDefault::default()),
        }
    }

    #[inline]
    pub fn put(&mut self, key: &[u8], value: &[u8]) {
        self.inner.insert(key.to_vec(), value.to_vec());
    }

    #[inline]
    pub fn get(&self, key: &[u8]) -> Option<&[u8]> {
        self.inner.get(key).map(|v| v.as_slice())
    }

    #[inline]
    pub fn del(&mut self, key: &[u8]) -> bool {
        self.inner.remove(key).is_some()
    }

    #[inline]
    pub fn has(&self, key: &[u8]) -> bool {
        self.inner.contains_key(key)
    }

    #[inline]
    pub fn len(&self) -> usize {
        self.inner.len()
    }

    #[inline]
    pub fn clear(&mut self) {
        self.inner.clear();
    }

    /// Bulk put. `buf` layout (all integers little-endian):
    /// `[u32 key_len][key][u32 val_len][val] ...`
    /// Returns the number of entries inserted.
    pub fn put_many(&mut self, mut buf: &[u8]) -> usize {
        let mut n = 0usize;
        while buf.len() >= 8 {
            let Some(kl) = read_u32(buf) else { break };
            buf = &buf[4..];
            if buf.len() < kl + 4 {
                break;
            }
            let key = &buf[..kl];
            buf = &buf[kl..];
            let Some(vl) = read_u32(buf) else { break };
            buf = &buf[4..];
            if buf.len() < vl {
                break;
            }
            let val = &buf[..vl];
            buf = &buf[vl..];
            self.put(key, val);
            n += 1;
        }
        n
    }

    /// Bulk get. `buf` layout (little-endian): `[u32 key_len][key] ...`
    /// Output layout: `[u32 count]` then per entry `[u32 val_len | MISSING][val]`.
    pub fn get_many(&self, buf: &[u8], out: &mut Vec<u8>) -> usize {
        let mut entries = 0usize;
        out.extend_from_slice(&0u32.to_le_bytes());
        let mut rest = buf;
        while rest.len() >= 4 {
            let Some(kl) = read_u32(rest) else { break };
            rest = &rest[4..];
            if rest.len() < kl {
                break;
            }
            let key = &rest[..kl];
            rest = &rest[kl..];
            match self.get(key) {
                Some(v) => {
                    out.extend_from_slice(&(v.len() as u32).to_le_bytes());
                    out.extend_from_slice(v);
                }
                None => out.extend_from_slice(&MISSING.to_le_bytes()),
            }
            entries += 1;
        }
        out[..4].copy_from_slice(&(entries as u32).to_le_bytes());
        entries
    }

    /// Number of output bytes `get_many` would produce for the given keys.
    pub fn get_many_size(&self, buf: &[u8]) -> usize {
        let mut total = 4usize;
        let mut rest = buf;
        while rest.len() >= 4 {
            let Some(kl) = read_u32(rest) else { break };
            rest = &rest[4..];
            if rest.len() < kl {
                break;
            }
            let key = &rest[..kl];
            rest = &rest[kl..];
            total += 4 + self.get(key).map(|v| v.len()).unwrap_or(0);
        }
        total
    }

    /// Serialize all entries into `out` (for snapshots):
    /// `[u32 count][u32 klen][key][u32 vlen][val] ...`
    /// Returns the number of entries written.
    pub fn entries_to_buf(&self, out: &mut Vec<u8>) -> usize {
        out.extend_from_slice(&(self.inner.len() as u32).to_le_bytes());
        for (k, v) in &self.inner {
            out.extend_from_slice(&(k.len() as u32).to_le_bytes());
            out.extend_from_slice(k);
            out.extend_from_slice(&(v.len() as u32).to_le_bytes());
            out.extend_from_slice(v);
        }
        self.inner.len()
    }
}

#[inline]
fn read_u32(b: &[u8]) -> Option<usize> {
    if b.len() < 4 {
        return None;
    }
    Some(u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize)
}