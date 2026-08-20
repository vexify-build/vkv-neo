//! vkv-neo native engine — N-API (Node-API) addon built with Rust.
//! Single global store shared per process. Powered By Vexify.

#![allow(clippy::missing_safety_doc)]

use std::ffi::{c_char, c_void};
use std::ptr;
use std::sync::{Mutex, OnceLock};

use napi_sys::*;
use vkv_core::Vkv;

const MISSING: u32 = u32::MAX;

static STORE: OnceLock<Mutex<Vkv>> = OnceLock::new();

#[inline]
fn store() -> &'static Mutex<Vkv> {
    STORE.get_or_init(|| Mutex::new(Vkv::new()))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

unsafe fn arg_count(env: napi_env, info: napi_callback_info) -> usize {
    let mut argc = 0usize;
    unsafe {
        napi_get_cb_info(env, info, &mut argc, ptr::null_mut(), ptr::null_mut(), ptr::null_mut());
    }
    argc
}

unsafe fn arg_at(env: napi_env, info: napi_callback_info, idx: usize) -> napi_value {
    let mut argc = arg_count(env, info);
    if idx >= argc {
        return ptr::null_mut();
    }
    let mut argv = vec![ptr::null_mut::<napi_value__>(); argc];
    unsafe {
        napi_get_cb_info(env, info, &mut argc, argv.as_mut_ptr(), ptr::null_mut(), ptr::null_mut());
    }
    argv[idx]
}

unsafe fn throw_err(env: napi_env, msg: &str) -> napi_value {
    let c = std::ffi::CString::new(msg).unwrap_or_default();
    unsafe {
        napi_throw_error(env, c".vkv".as_ptr(), c.as_ptr());
    }
    undefined(env)
}

unsafe fn undefined(env: napi_env) -> napi_value {
    let mut out = ptr::null_mut();
    unsafe {
        napi_get_undefined(env, &mut out);
    }
    out
}

unsafe fn number(env: napi_env, n: f64) -> napi_value {
    let mut out = ptr::null_mut();
    unsafe {
        napi_create_double(env, n, &mut out);
    }
    out
}

unsafe fn boolean(env: napi_env, b: bool) -> napi_value {
    let mut out = ptr::null_mut();
    unsafe {
        napi_get_boolean(env, b, &mut out);
    }
    out
}

/// Read a JS value as raw bytes:
/// - string    -> UTF-8 encoded
/// - Buffer    -> raw bytes
/// - Uint8Array-> raw bytes
unsafe fn to_bytes(env: napi_env, value: napi_value) -> Option<Vec<u8>> {
    if value.is_null() {
        return None;
    }
    let mut ty = ValueType::napi_undefined;
    unsafe {
        napi_typeof(env, value, &mut ty);
    }
    match ty {
        ValueType::napi_string => {
            let mut copied = 0usize;
            let status = unsafe {
                napi_get_value_string_utf8(env, value, ptr::null_mut(), 0, &mut copied)
            };
            if status != Status::napi_ok {
                return None;
            }
            let mut buf = vec![0u8; copied + 1];
            let mut used = 0usize;
            let status = unsafe {
                napi_get_value_string_utf8(
                    env,
                    value,
                    buf.as_mut_ptr() as *mut c_char,
                    buf.len(),
                    &mut used,
                )
            };
            if status != Status::napi_ok {
                return None;
            }
            buf.truncate(used);
            Some(buf)
        }
        ValueType::napi_object | ValueType::napi_external => {
            // Buffer?
            let mut is_buffer = false;
            unsafe {
                napi_is_buffer(env, value, &mut is_buffer);
            }
            if is_buffer {
                let mut data: *mut c_void = ptr::null_mut();
                let mut len = 0usize;
                let status = unsafe { napi_get_buffer_info(env, value, &mut data, &mut len) };
                if status != Status::napi_ok {
                    return None;
                }
                if len == 0 {
                    return Some(Vec::new());
                }
                Some(unsafe { std::slice::from_raw_parts(data as *const u8, len) }.to_vec())
            } else {
                // Uint8Array / other typed array?
                let mut is_ta = false;
                unsafe {
                    napi_is_typedarray(env, value, &mut is_ta);
                }
                if is_ta {
                    let mut ta_type: napi_typedarray_type = TypedarrayType::uint8_array;
                    let mut len = 0usize;
                    let mut data: *mut c_void = ptr::null_mut();
                    let mut ab: napi_value = ptr::null_mut();
                    let mut off = 0usize;
                    let status =
                        unsafe { napi_get_typedarray_info(env, value, &mut ta_type, &mut len, &mut data, &mut ab, &mut off) };
                    if status != Status::napi_ok {
                        return None;
                    }
                    if len == 0 {
                        return Some(Vec::new());
                    }
                    Some(unsafe { std::slice::from_raw_parts(data as *const u8, len) }.to_vec())
                } else {
                    None
                }
            }
        }
        _ => None,
    }
}

/// Build a Buffer (copied) from bytes.
unsafe fn copy_to_buffer(env: napi_env, data: &[u8]) -> napi_value {
    let mut out = ptr::null_mut();
    let mut copied: *mut c_void = ptr::null_mut();
    let status = unsafe {
        napi_create_buffer_copy(env, data.len(), data.as_ptr() as *const c_void, &mut copied, &mut out)
    };
    if status != Status::napi_ok {
        return undefined(env);
    }
    out
}

// ---------------------------------------------------------------------------
// Exported N-API funcs
// ---------------------------------------------------------------------------

unsafe extern "C" fn set_cb(env: napi_env, info: napi_callback_info) -> napi_value {
    let key = unsafe { arg_at(env, info, 0) };
    let val = unsafe { arg_at(env, info, 1) };
    let Some(key) = (unsafe { to_bytes(env, key) }) else {
        return unsafe { throw_err(env, "set(key, value): invalid key") };
    };
    let Some(val) = (unsafe { to_bytes(env, val) }) else {
        return unsafe { throw_err(env, "set(key, value): invalid value") };
    };
    store().lock().unwrap().put(&key, &val);
    unsafe { undefined(env) }
}

unsafe extern "C" fn get_cb(env: napi_env, info: napi_callback_info) -> napi_value {
    let key = unsafe { arg_at(env, info, 0) };
    let Some(key) = (unsafe { to_bytes(env, key) }) else {
        return unsafe { throw_err(env, "get(key): invalid key") };
    };
    match store().lock().unwrap().get(&key) {
        Some(v) => unsafe { copy_to_buffer(env, v) },
        None => unsafe { undefined(env) },
    }
}

unsafe extern "C" fn has_cb(env: napi_env, info: napi_callback_info) -> napi_value {
    let key = unsafe { arg_at(env, info, 0) };
    let Some(key) = (unsafe { to_bytes(env, key) }) else {
        return unsafe { throw_err(env, "has(key): invalid key") };
    };
    let b = store().lock().unwrap().has(&key);
    unsafe { boolean(env, b) }
}

unsafe extern "C" fn del_cb(env: napi_env, info: napi_callback_info) -> napi_value {
    let key = unsafe { arg_at(env, info, 0) };
    let Some(key) = (unsafe { to_bytes(env, key) }) else {
        return unsafe { throw_err(env, "del(key): invalid key") };
    };
    let b = store().lock().unwrap().del(&key);
    unsafe { boolean(env, b) }
}

unsafe extern "C" fn len_cb(env: napi_env, _info: napi_callback_info) -> napi_value {
    let n = store().lock().unwrap().len() as f64;
    unsafe { number(env, n) }
}

unsafe extern "C" fn clear_cb(env: napi_env, _info: napi_callback_info) -> napi_value {
    store().lock().unwrap().clear();
    unsafe { undefined(env) }
}

unsafe extern "C" fn put_many_cb(env: napi_env, info: napi_callback_info) -> napi_value {
    let buf = unsafe { arg_at(env, info, 0) };
    let Some(buf) = (unsafe { to_bytes(env, buf) }) else {
        return unsafe { throw_err(env, "putMany(buf): invalid buffer") };
    };
    let n = store().lock().unwrap().put_many(&buf) as f64;
    unsafe { number(env, n) }
}

unsafe extern "C" fn get_many_cb(env: napi_env, info: napi_callback_info) -> napi_value {
    let buf = unsafe { arg_at(env, info, 0) };
    let Some(buf) = (unsafe { to_bytes(env, buf) }) else {
        return unsafe { throw_err(env, "getMany(buf): invalid buffer") };
    };
    let store = store().lock().unwrap();
    let needed = store.get_many_size(&buf);
    let mut collected = Vec::with_capacity(needed);
    store.get_many(&buf, &mut collected);
    unsafe { copy_to_buffer(env, &collected) }
}

unsafe extern "C" fn entries_cb(env: napi_env, _info: napi_callback_info) -> napi_value {
    let store = store().lock().unwrap();
    let mut buf = Vec::with_capacity(128);
    store.entries_to_buf(&mut buf);
    unsafe { copy_to_buffer(env, &buf) }
}

unsafe extern "C" fn version_cb(env: napi_env, _info: napi_callback_info) -> napi_value {
    unsafe { number(env, 1.0) }
}

// ---------------------------------------------------------------------------
// Module registration
// ---------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn napi_register_module_v1(env: napi_env, exports: napi_value) -> napi_value {
    extern "C" fn meth(f: unsafe extern "C" fn(napi_env, napi_callback_info) -> napi_value) -> Option<unsafe extern "C" fn(napi_env, napi_callback_info) -> napi_value> {
        Some(f)
    }

    let props = [
        napi_property_descriptor {
            utf8name: c"set".as_ptr(),
            name: ptr::null_mut(),
            method: meth(set_cb),
            getter: None,
            setter: None,
            value: ptr::null_mut(),
            attributes: PropertyAttributes::writable | PropertyAttributes::enumerable | PropertyAttributes::configurable,
            data: ptr::null_mut(),
        },
        napi_property_descriptor {
            utf8name: c"get".as_ptr(),
            name: ptr::null_mut(),
            method: meth(get_cb),
            getter: None,
            setter: None,
            value: ptr::null_mut(),
            attributes: PropertyAttributes::writable | PropertyAttributes::enumerable | PropertyAttributes::configurable,
            data: ptr::null_mut(),
        },
        napi_property_descriptor {
            utf8name: c"has".as_ptr(),
            name: ptr::null_mut(),
            method: meth(has_cb),
            getter: None,
            setter: None,
            value: ptr::null_mut(),
            attributes: PropertyAttributes::writable | PropertyAttributes::enumerable | PropertyAttributes::configurable,
            data: ptr::null_mut(),
        },
        napi_property_descriptor {
            utf8name: c"del".as_ptr(),
            name: ptr::null_mut(),
            method: meth(del_cb),
            getter: None,
            setter: None,
            value: ptr::null_mut(),
            attributes: PropertyAttributes::writable | PropertyAttributes::enumerable | PropertyAttributes::configurable,
            data: ptr::null_mut(),
        },
        napi_property_descriptor {
            utf8name: c"len".as_ptr(),
            name: ptr::null_mut(),
            method: meth(len_cb),
            getter: None,
            setter: None,
            value: ptr::null_mut(),
            attributes: PropertyAttributes::writable | PropertyAttributes::enumerable | PropertyAttributes::configurable,
            data: ptr::null_mut(),
        },
        napi_property_descriptor {
            utf8name: c"clear".as_ptr(),
            name: ptr::null_mut(),
            method: meth(clear_cb),
            getter: None,
            setter: None,
            value: ptr::null_mut(),
            attributes: PropertyAttributes::writable | PropertyAttributes::enumerable | PropertyAttributes::configurable,
            data: ptr::null_mut(),
        },
        napi_property_descriptor {
            utf8name: c"putMany".as_ptr(),
            name: ptr::null_mut(),
            method: meth(put_many_cb),
            getter: None,
            setter: None,
            value: ptr::null_mut(),
            attributes: PropertyAttributes::writable | PropertyAttributes::enumerable | PropertyAttributes::configurable,
            data: ptr::null_mut(),
        },
        napi_property_descriptor {
            utf8name: c"getMany".as_ptr(),
            name: ptr::null_mut(),
            method: meth(get_many_cb),
            getter: None,
            setter: None,
            value: ptr::null_mut(),
            attributes: PropertyAttributes::writable | PropertyAttributes::enumerable | PropertyAttributes::configurable,
            data: ptr::null_mut(),
        },
        napi_property_descriptor {
            utf8name: c"entries".as_ptr(),
            name: ptr::null_mut(),
            method: meth(entries_cb),
            getter: None,
            setter: None,
            value: ptr::null_mut(),
            attributes: PropertyAttributes::writable | PropertyAttributes::enumerable | PropertyAttributes::configurable,
            data: ptr::null_mut(),
        },
        napi_property_descriptor {
            utf8name: c"version".as_ptr(),
            name: ptr::null_mut(),
            method: meth(version_cb),
            getter: None,
            setter: None,
            value: ptr::null_mut(),
            attributes: PropertyAttributes::writable | PropertyAttributes::enumerable | PropertyAttributes::configurable,
            data: ptr::null_mut(),
        },
    ];

    let status = unsafe { napi_define_properties(env, exports, props.len(), props.as_ptr()) };
    let _ = status;
    exports
}