//! Enough of a NetCDF-4 / HDF5 reader to pull GOES-East GLM flash positions.
//! No libhdf5. Shuffle is undone after inflate.

use flate2::read::ZlibDecoder;
use std::io::Read;

#[derive(Clone, Debug)]
struct HeaderMessage {
    kind: u8,
    body: Vec<u8>,
}

#[derive(Clone, Debug)]
struct ObjectHeader {
    messages: Vec<HeaderMessage>,
    continuations: Vec<(u64, u64)>,
}

pub fn read_flashes(file: &[u8]) -> Result<Vec<(f32, f32)>, String> {
    let mut lat: Option<(u64, bool)> = None;
    let mut lon: Option<(u64, bool)> = None;
    let mut offset = 0;
    while let Some(found) = find_subsequence(file, b"OHDR", offset) {
        offset = found + 4;
        let Some(header) = parse_object_header(file, found) else {
            continue;
        };
        let attrs = attributes(file, &header);
        let units = attr_text(&attrs, "units");
        let long_name = attr_text(&attrs, "long_name").to_ascii_lowercase();
        if !long_name.contains("flash centroid") {
            continue;
        }
        let Some(btree) = layout_btree(&header) else {
            continue;
        };
        if units == "degrees_north" {
            lat = Some((btree, pipeline_shuffles(&header)));
        } else if units == "degrees_east" {
            lon = Some((btree, pipeline_shuffles(&header)));
        }
    }
    let (lat_addr, lat_shuffle) = lat.ok_or("This GLM file has no flash positions.")?;
    let (lon_addr, lon_shuffle) = lon.ok_or("This GLM file has no flash positions.")?;
    let lats = read_series(file, lat_addr, lat_shuffle)?;
    let lons = read_series(file, lon_addr, lon_shuffle)?;
    let mut out = Vec::new();
    for (lat, lon) in lats.into_iter().zip(lons) {
        if lat.is_finite() && lon.is_finite() && lat.abs() <= 90.0 && lon.abs() <= 180.0 {
            out.push((lat, lon));
        }
    }
    Ok(out)
}

fn read_series(file: &[u8], btree: u64, shuffle: bool) -> Result<Vec<f32>, String> {
    if btree == u64::MAX {
        return Ok(Vec::new());
    }
    let chunks = btree_chunks(file, btree)?;
    let mut values = Vec::new();
    for (addr, size) in chunks {
        let start = addr as usize;
        let end = start.saturating_add(size as usize);
        if end > file.len() || size == 0 {
            continue;
        }
        values.extend(decode_chunk(&file[start..end], shuffle));
    }
    Ok(values)
}

fn decode_chunk(bytes: &[u8], shuffle: bool) -> Vec<f32> {
    let inflated = inflate(bytes).unwrap_or_else(|_| bytes.to_vec());
    let raw = if shuffle { unshuffle(&inflated, 4) } else { inflated };
    raw.chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect()
}

fn inflate(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut decoder = ZlibDecoder::new(bytes);
    let mut out = Vec::new();
    decoder
        .read_to_end(&mut out)
        .map_err(|err| format!("inflate: {err}"))?;
    Ok(out)
}

fn unshuffle(shuffled: &[u8], elem: usize) -> Vec<u8> {
    if elem == 0 || shuffled.len() % elem != 0 {
        return shuffled.to_vec();
    }
    let n = shuffled.len() / elem;
    let mut out = vec![0u8; shuffled.len()];
    for i in 0..elem {
        for j in 0..n {
            out[j * elem + i] = shuffled[i * n + j];
        }
    }
    out
}

fn btree_chunks(file: &[u8], addr: u64) -> Result<Vec<(u64, u64)>, String> {
    let start = addr as usize;
    if start + 24 > file.len() || &file[start..start + 4] != b"TREE" {
        return Err("GLM chunk index is not a btree.".into());
    }
    let node_type = file[start + 4];
    let level = file[start + 5];
    let nentries = u16::from_le_bytes([file[start + 6], file[start + 7]]) as usize;
    let records = start + 4 + 1 + 1 + 2 + 8 + 8;
    if node_type != 1 {
        return Err("Unexpected GLM btree type.".into());
    }
    if level == 0 {
        let mut out = Vec::new();
        for index in 0..nentries {
            let rec = records + index * 32;
            if rec + 32 > file.len() {
                break;
            }
            let size = u64::from_le_bytes(file[rec..rec + 8].try_into().unwrap());
            let child = u64::from_le_bytes(file[rec + 24..rec + 32].try_into().unwrap());
            if child != u64::MAX && size > 0 {
                out.push((child, size));
            }
        }
        return Ok(out);
    }
    let mut out = Vec::new();
    for index in 0..nentries {
        let rec = records + index * 16;
        if rec + 16 > file.len() {
            break;
        }
        let child = u64::from_le_bytes(file[rec + 8..rec + 16].try_into().unwrap());
        if child != u64::MAX {
            out.extend(btree_chunks(file, child)?);
        }
    }
    Ok(out)
}

fn layout_btree(header: &ObjectHeader) -> Option<u64> {
    for message in &header.messages {
        if message.kind != 0x08 || message.body.len() < 11 {
            continue;
        }
        let body = &message.body;
        if body[0] == 3 && body[1] == 2 {
            return Some(u64::from_le_bytes(body[3..11].try_into().unwrap()));
        }
    }
    None
}

fn pipeline_shuffles(header: &ObjectHeader) -> bool {
    for message in &header.messages {
        if message.kind != 0x0b || message.body.len() < 2 {
            continue;
        }
        let body = &message.body;
        let count = body[1] as usize;
        let mut cursor = 2;
        for _ in 0..count {
            if cursor + 6 > body.len() {
                break;
            }
            let id = u16::from_le_bytes([body[cursor], body[cursor + 1]]);
            let nparams = u16::from_le_bytes([body[cursor + 4], body[cursor + 5]]) as usize;
            if id == 2 {
                return true;
            }
            cursor += 6 + nparams * 4;
        }
    }
    false
}

fn attributes(file: &[u8], header: &ObjectHeader) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for message in &header.messages {
        if message.kind == 0x0c {
            if let Some(pair) = attribute_pair(&message.body) {
                out.push(pair);
            }
        }
    }
    for &(addr, len) in &header.continuations {
        let start = addr as usize;
        let end = start.saturating_add(len as usize);
        if end > file.len() || len < 8 || &file[start..start + 4] != b"OCHK" {
            continue;
        }
        let Some(continued) = parse_messages(file, start + 4, end.saturating_sub(4), 6) else {
            continue;
        };
        for message in continued {
            if message.kind == 0x0c {
                if let Some(pair) = attribute_pair(&message.body) {
                    out.push(pair);
                }
            }
        }
    }
    out
}

fn attribute_pair(body: &[u8]) -> Option<(String, String)> {
    if body.first().copied() != Some(3) || body.len() < 8 {
        return None;
    }
    let name_size = u16::from_le_bytes([body[2], body[3]]) as usize;
    let dtype_size = u16::from_le_bytes([body[4], body[5]]) as usize;
    let space_size = u16::from_le_bytes([body[6], body[7]]) as usize;
    let name_at = 8;
    let name_end = name_at + name_size;
    let data_at = name_end + dtype_size + space_size;
    if data_at > body.len() || name_end > body.len() {
        return None;
    }
    let name = clean_text(&body[name_at..name_end]);
    let value = clean_text(&body[data_at..]);
    if name.is_empty() {
        return None;
    }
    Some((name, value))
}

fn attr_text(attrs: &[(String, String)], key: &str) -> String {
    attrs
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(key))
        .map(|(_, value)| value.clone())
        .unwrap_or_default()
}

fn clean_text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .trim_matches(char::from(0))
        .trim()
        .to_string()
}

fn parse_object_header(file: &[u8], offset: usize) -> Option<ObjectHeader> {
    if offset + 8 > file.len() || &file[offset..offset + 4] != b"OHDR" || file[offset + 4] != 2 {
        return None;
    }
    let flags = file[offset + 5];
    let chunk = u16::from_le_bytes([file[offset + 6], file[offset + 7]]) as usize;
    let header_len = if flags & 0x04 != 0 { 6 } else { 4 };
    let start = offset + 8;
    let end = start + chunk;
    if end > file.len() {
        return None;
    }
    let messages = parse_messages(file, start, end, header_len)?;
    let mut continuations = Vec::new();
    for message in &messages {
        if message.kind == 0x10 && message.body.len() >= 16 {
            let addr = u64::from_le_bytes(message.body[0..8].try_into().unwrap());
            let len = u64::from_le_bytes(message.body[8..16].try_into().unwrap());
            if addr != u64::MAX && len > 0 {
                continuations.push((addr, len));
            }
        }
    }
    Some(ObjectHeader {
        messages,
        continuations,
    })
}

fn parse_messages(file: &[u8], start: usize, end: usize, header_len: usize) -> Option<Vec<HeaderMessage>> {
    if end > file.len() || header_len < 4 {
        return None;
    }
    let mut out = Vec::new();
    let mut cursor = start;
    while cursor + header_len <= end {
        let kind = file[cursor];
        let size = u16::from_le_bytes([file[cursor + 1], file[cursor + 2]]) as usize;
        let body_at = cursor + header_len;
        if size == 0 && kind == 0 {
            break;
        }
        if body_at + size > end {
            return if out.is_empty() { None } else { Some(out) };
        }
        out.push(HeaderMessage {
            kind,
            body: file[body_at..body_at + size].to_vec(),
        });
        cursor = body_at + size;
        if out.len() > 64 {
            break;
        }
    }
    Some(out)
}

fn find_subsequence(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    haystack[from..]
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|index| from + index)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flash_lat_chunk_decodes() {
        let bytes = include_bytes!("fixtures/flash_lat_chunk.bin");
        let values = decode_chunk(bytes, true);
        let finite: Vec<f32> = values.into_iter().filter(|value| value.is_finite() && value.abs() < 1000.0).collect();
        assert_eq!(finite.len(), 523);
        assert!((finite[0] - 24.71859).abs() < 0.001, "{}", finite[0]);
    }

    #[test]
    fn flash_lon_chunk_decodes() {
        let bytes = include_bytes!("fixtures/flash_lon_chunk.bin");
        let values = decode_chunk(bytes, true);
        let finite: Vec<f32> = values.into_iter().filter(|value| value.is_finite() && value.abs() < 1000.0).collect();
        assert_eq!(finite.len(), 523);
        assert!((finite[0] - -82.48244).abs() < 0.001, "{}", finite[0]);
    }

    #[test]
    fn object_header_points_at_the_chunk_index() {
        let bytes = include_bytes!("fixtures/flash_lat_ohdr.bin");
        let header = parse_object_header(bytes, 0).unwrap();
        assert_eq!(layout_btree(&header), Some(0x22169));
        assert!(pipeline_shuffles(&header));
        let attrs = attributes(bytes, &header);
        assert_eq!(attr_text(&attrs, "units"), "degrees_north");
    }

    #[test]
    fn sample_file_when_present() {
        let path = "/tmp/cc-samples/glm.nc";
        if !std::path::Path::new(path).exists() {
            return;
        }
        let bytes = std::fs::read(path).unwrap();
        let flashes = read_flashes(&bytes).unwrap();
        assert_eq!(flashes.len(), 523);
        assert!((flashes[0].0 - 24.71859).abs() < 0.001);
        assert!((flashes[0].1 - -82.48244).abs() < 0.001);
    }
}
