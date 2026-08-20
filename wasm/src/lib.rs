//! vkv-neo WASM engine — exported C ABI functions consumed from JS.
//! Single global store (one instance per loaded WASM module).
//! Powered By Vexify.
//!
//! NOTE: wasm32-unknown-unknown is single-threaded; std::sync::Mutex on this
//! target asserts on recursive acquire, so we use a plain raw-pointer store.

use std::alloc::{alloc, dealloc, Layout};
use std::ptr;
use std::sync::OnceLock;

use vkv_core::Vkv;

static INIT: OnceLock<()> = OnceLock::new();
static mut STORE: *mut Vkv = ptr::null_mut();

/// Ensure the store exists (idempotent, single-threaded).
#[no_mangle]
pub extern "C" fn vkv_init() -> i32 {
    INIT.get_or_init(|| unsafe { STORE = Box::into_raw(Box::new(Vkv::new())) });
    0
}

#[inline]
fn store() -> &'static mut Vkv {
    unsafe {
        vkv_init();
        &mut *STORE
    }
}

fn layout(len: usize) -> Layout {
    Layout::from_size_align(len.max(1), 1).unwrap()
}

// ---------------------------------------------------------------------------
// Memory helpers
// ---------------------------------------------------------------------------

/// Allocate `len` bytes in the wasm linear memory. Returns pointer.
#[no_mangle]
pub extern "C" fn vkv_alloc(len: usize) -> *mut u8 {
    unsafe { alloc(layout(len)) }
}

/// Free a previously `vkv_alloc`'d block.
#[no_mangle]
pub extern "C" fn vkv_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        unsafe { dealloc(ptr, layout(len)) }
    }
}

unsafe fn read_slice<'a>(p: *const u8, len: usize) -> &'a [u8] {
    if len == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(p, len) }
    }
}

// ---------------------------------------------------------------------------
// Single ops
// ---------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn vkv_put(kp: *const u8, kl: usize, vp: *const u8, vl: usize) {
    let key = unsafe { read_slice(kp, kl) }.to_vec();
    let val = unsafe { read_slice(vp, vl) }.to_vec();
    store().put(&key, &val);
}

/// Returns value length, or `i64::MIN` if missing, or `-(needed)` if buffer
/// too small (needed >= 1, so `-(needed)` can never collide with i64::MIN).
#[no_mangle]
pub extern "C" fn vkv_get(kp: *const u8, kl: usize, out: *mut u8, cap: usize) -> i64 {
    let key = unsafe { read_slice(kp, kl) };
    let store = store();
    match store.get(key) {
        None => i64::MIN,
        Some(v) => {
            if v.len() > cap {
                return -(v.len() as i64);
            }
            if !v.is_empty() && !out.is_null() {
                unsafe { ptr::copy_nonoverlapping(v.as_ptr(), out, v.len()) };
            }
            v.len() as i64
        }
    }
}

#[no_mangle]
pub extern "C" fn vkv_has(kp: *const u8, kl: usize) -> i32 {
    let key = unsafe { read_slice(kp, kl) };
    store().has(key) as i32
}

#[no_mangle]
pub extern "C" fn vkv_del(kp: *const u8, kl: usize) -> i32 {
    let key = unsafe { read_slice(kp, kl) }.to_vec();
    store().del(&key) as i32
}

#[no_mangle]
pub extern "C" fn vkv_len() -> u32 {
    store().len() as u32
}

#[no_mangle]
pub extern "C" fn vkv_clear() {
    store().clear();
}

// ---------------------------------------------------------------------------
// Bulk ops
// ---------------------------------------------------------------------------

/// Input: `[u32 klen][key][u32 vlen][val] ...`. Returns entries inserted.
#[no_mangle]
pub extern "C" fn vkv_put_many(buf: *const u8, len: usize) -> u32 {
    let input = unsafe { read_slice(buf, len) };
    store().put_many(input) as u32
}

/// Input: `[u32 klen][key] ...`.
/// Returns bytes written to `out`, or `-(needed)` if `cap` is too small.
#[no_mangle]
pub extern "C" fn vkv_get_many(buf: *const u8, len: usize, out: *mut u8, cap: usize) -> i64 {
    let input = unsafe { read_slice(buf, len) };
    let store = store();
    let needed = store.get_many_size(input);
    if needed > cap {
        return -(needed as i64);
    }
    if !out.is_null() {
        let mut collected = Vec::with_capacity(needed);
        store.get_many(input, &mut collected);
        unsafe {
            ptr::copy_nonoverlapping(collected.as_ptr(), out, collected.len());
        }
        collected.len() as i64
    } else {
        0
    }
}

/// Serialize all entries for snapshots.
/// Format: `[u32 count][u32 klen][key][u32 vlen][val] ...`
/// Returns bytes written, or `-(needed)` if `cap` is too small.
#[no_mangle]
pub extern "C" fn vkv_entries(out: *mut u8, cap: usize) -> i64 {
    let store = store();
    let mut buf = Vec::with_capacity(128);
    store.entries_to_buf(&mut buf);
    if buf.len() > cap {
        return -(buf.len() as i64);
    }
    if !out.is_null() && !buf.is_empty() {
        unsafe {
            ptr::copy_nonoverlapping(buf.as_ptr(), out, buf.len());
        }
    }
    buf.len() as i64
}

#[no_mangle]
pub extern "C" fn vkv_version() -> i32 {
    1
}