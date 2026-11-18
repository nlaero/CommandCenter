//! Enough of a protobuf walk to read GTFS-RT service alerts.

#[derive(Clone, Debug)]
pub struct ServiceAlert {
    pub id: String,
    pub header: String,
    pub description: String,
    pub url: String,
}

pub fn alerts(bytes: &[u8]) -> Vec<ServiceAlert> {
    let mut out = Vec::new();
    for entity in fields(bytes).into_iter().filter(|field| field.num == 2) {
        let Some(body) = entity.bytes else { continue };
        let mut id = String::new();
        let mut alert = None;
        for field in fields(&body) {
            if field.num == 1 {
                if let Some(bytes) = field.bytes.as_deref() {
                    id = String::from_utf8_lossy(bytes).trim().to_string();
                }
            }
            if field.num == 5 {
                alert = field.bytes;
            }
        }
        let Some(alert) = alert else { continue };
        let mut header = String::new();
        let mut description = String::new();
        let mut url = String::new();
        for field in fields(&alert) {
            match field.num {
                8 => {
                    if let Some(bytes) = field.bytes {
                        url = String::from_utf8_lossy(&bytes).trim().to_string();
                    }
                }
                10 => {
                    if let Some(bytes) = field.bytes {
                        header = translated(&bytes);
                    }
                }
                11 => {
                    if let Some(bytes) = field.bytes {
                        description = translated(&bytes);
                    }
                }
                _ => {}
            }
        }
        if header.is_empty() && description.is_empty() {
            continue;
        }
        if id.is_empty() {
            id = format!("alert-{}", out.len() + 1);
        }
        out.push(ServiceAlert {
            id,
            header,
            description,
            url,
        });
    }
    out
}

fn translated(bytes: &[u8]) -> String {
    for field in fields(bytes) {
        if field.num != 1 {
            continue;
        }
        let Some(inner) = field.bytes else { continue };
        for part in fields(&inner) {
            if part.num == 1 {
                if let Some(text) = part.bytes {
                    let value = String::from_utf8_lossy(&text).trim().to_string();
                    if !value.is_empty() {
                        return value;
                    }
                }
            }
        }
    }
    String::new()
}

struct Field {
    num: u64,
    bytes: Option<Vec<u8>>,
}

fn fields(data: &[u8]) -> Vec<Field> {
    let mut out = Vec::new();
    let mut index = 0;
    while index < data.len() {
        let Some((key, next)) = varint(data, index) else { break };
        index = next;
        let num = key >> 3;
        let wire = key & 7;
        match wire {
            0 => {
                let Some((_, next)) = varint(data, index) else { break };
                index = next;
            }
            1 => {
                if index + 8 > data.len() {
                    break;
                }
                index += 8;
            }
            2 => {
                let Some((len, next)) = varint(data, index) else { break };
                index = next;
                let len = len as usize;
                if index + len > data.len() {
                    break;
                }
                out.push(Field {
                    num,
                    bytes: Some(data[index..index + len].to_vec()),
                });
                index += len;
            }
            5 => {
                if index + 4 > data.len() {
                    break;
                }
                index += 4;
            }
            _ => break,
        }
    }
    out
}

fn varint(data: &[u8], mut index: usize) -> Option<(u64, usize)> {
    let mut value = 0u64;
    let mut shift = 0;
    while index < data.len() && shift < 64 {
        let byte = data[index];
        index += 1;
        value |= ((byte & 0x7f) as u64) << shift;
        if byte & 0x80 == 0 {
            return Some((value, index));
        }
        shift += 7;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prt_fixture_has_the_west_liberty_closure() {
        let bytes = include_bytes!("fixtures/prt_alerts.bin");
        let rows = alerts(bytes);
        assert!(rows.len() >= 3, "{}", rows.len());
        assert!(rows.iter().any(|row| row.header.contains("West Lib") || row.description.contains("West Lib")));
    }
}
