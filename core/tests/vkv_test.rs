use vkv_core::Vkv;

#[test]
fn get_many_roundtrip() {
    let mut s = Vkv::new();
    let mut buf = Vec::new();
    let key = b"abc";
    buf.extend_from_slice(&(key.len() as u32).to_le_bytes());
    buf.extend_from_slice(key);
    buf.extend_from_slice(&(3u32).to_le_bytes());
    buf.extend_from_slice(b"xyz");
    assert_eq!(s.put_many(&buf), 1);
    assert_eq!(s.len(), 1);

    let mut q = Vec::new();
    q.extend_from_slice(&(3u32).to_le_bytes());
    q.extend_from_slice(b"abc");
    assert_eq!(s.get_many_size(&q), 11);
    let mut out = Vec::new();
    let n = s.get_many(&q, &mut out);
    assert_eq!(n, 1);
    assert_eq!(out.len(), 11);
    assert_eq!(&out[4..8], &[3u8, 0, 0, 0]);
    assert_eq!(&out[8..], b"xyz");

    // missing key
    let mut q2 = Vec::new();
    q2.extend_from_slice(&(1u32).to_le_bytes());
    q2.push(b'x');
    let mut out2 = Vec::new();
    s.get_many(&q2, &mut out2);
    assert_eq!(out2.len(), 8);
    assert_eq!(u32::from_le_bytes([out2[4], out2[5], out2[6], out2[7]]), u32::MAX);
}

#[test]
fn big_bulk() {
    let mut s = Vkv::new();
    let n = 100_000usize;
    let mut buf = Vec::with_capacity(n * 32);
    for i in 0..n {
        let k = format!("key-{:08}", i);
        let v = format!("val-{:08}", i);
        buf.extend_from_slice(&(k.len() as u32).to_le_bytes());
        buf.extend_from_slice(k.as_bytes());
        buf.extend_from_slice(&(v.len() as u32).to_le_bytes());
        buf.extend_from_slice(v.as_bytes());
    }
    assert_eq!(s.put_many(&buf), n);
    let mut q = Vec::with_capacity(n * 18);
    for i in 0..n {
        let k = format!("key-{:08}", i);
        q.extend_from_slice(&(k.len() as u32).to_le_bytes());
        q.extend_from_slice(k.as_bytes());
    }
    let mut out = Vec::new();
    let m = s.get_many(&q, &mut out);
    assert_eq!(m, n);
    assert_eq!(out.len(), 4 + n * 16);
}