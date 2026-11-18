//! Minimal xlsx reader for the Coast Guard caller-report workbook.

use std::collections::BTreeMap;
use std::io::{Cursor, Read};

pub type Row = BTreeMap<String, String>;

pub fn sheets_by_name(bytes: &[u8], wanted: &[&str]) -> Result<BTreeMap<String, Vec<Row>>, String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|err| format!("workbook: {err}"))?;
    let workbook = read_zip(&mut archive, "xl/workbook.xml")?;
    let rels = read_zip(&mut archive, "xl/_rels/workbook.xml.rels")?;
    let strings = read_zip(&mut archive, "xl/sharedStrings.xml").unwrap_or_default();
    let shared = shared_strings(&strings);
    let targets = sheet_targets(&workbook, &rels);
    let mut out = BTreeMap::new();
    for name in wanted {
        let Some(target) = targets.get(*name) else {
            continue;
        };
        let path = if target.starts_with("xl/") {
            target.clone()
        } else if target.starts_with('/') {
            target.trim_start_matches('/').to_string()
        } else {
            format!("xl/{target}")
        };
        let xml = read_zip(&mut archive, &path)?;
        out.insert((*name).to_string(), parse_sheet(&xml, &shared));
    }
    Ok(out)
}

fn read_zip(archive: &mut zip::ZipArchive<Cursor<&[u8]>>, name: &str) -> Result<String, String> {
    let mut file = archive
        .by_name(name)
        .map_err(|_| format!("workbook is missing {name}"))?;
    let mut text = String::new();
    file.read_to_string(&mut text)
        .map_err(|err| format!("workbook {name}: {err}"))?;
    Ok(text)
}

fn sheet_targets(workbook: &str, rels: &str) -> BTreeMap<String, String> {
    let mut id_to_target = BTreeMap::new();
    for tag in tags(rels, "Relationship") {
        let id = attr(&tag, "Id");
        let target = attr(&tag, "Target");
        if !id.is_empty() && !target.is_empty() {
            id_to_target.insert(id, target);
        }
    }
    let mut out = BTreeMap::new();
    for tag in tags(workbook, "sheet") {
        let name = attr(&tag, "name");
        let id = attr(&tag, "id");
        if let Some(target) = id_to_target.get(&id) {
            out.insert(name, target.clone());
        }
    }
    out
}

fn shared_strings(xml: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find("<si") {
        rest = &rest[start..];
        let Some(end) = rest.find("</si>") else { break };
        let block = &rest[..end];
        let mut text = String::new();
        let mut cursor = block;
        while let Some(open) = cursor.find("<t") {
            cursor = &cursor[open..];
            let Some(gt) = cursor.find('>') else { break };
            let after = &cursor[gt + 1..];
            let Some(close) = after.find("</t>") else { break };
            text.push_str(&unescape(&after[..close]));
            cursor = &after[close + 4..];
        }
        out.push(text);
        rest = &rest[end + 5..];
    }
    out
}

fn parse_sheet(xml: &str, shared: &[String]) -> Vec<Row> {
    let mut rows = Vec::new();
    let mut headers: BTreeMap<usize, String> = BTreeMap::new();
    let mut rest = xml;
    while let Some(start) = rest.find("<row") {
        rest = &rest[start..];
        let Some(end) = rest.find("</row>") else { break };
        let block = &rest[..end];
        let mut cells: Vec<(usize, String)> = Vec::new();
        let mut cursor = block;
        while let Some(cell_at) = cursor.find("<c ") {
            cursor = &cursor[cell_at..];
            let Some(gt) = cursor.find('>') else { break };
            let open = &cursor[..=gt];
            let reference = attr(open, "r");
            let kind = attr(open, "t");
            let after = &cursor[gt + 1..];
            let value = if open.contains("/>") {
                String::new()
            } else if kind == "inlineStr" {
                text_between(after, "<t", "</t>").unwrap_or_default()
            } else {
                text_between(after, "<v", "</v>").unwrap_or_default()
            };
            let text = if kind == "s" {
                value
                    .parse::<usize>()
                    .ok()
                    .and_then(|index| shared.get(index))
                    .cloned()
                    .unwrap_or_default()
            } else {
                unescape(&value)
            };
            if !reference.is_empty() {
                cells.push((column_index(&reference), text));
            }
            let next = if open.contains("/>") {
                gt + 1
            } else {
                after.find("</c>").map(|index| gt + 1 + index + 4).unwrap_or(gt + 1)
            };
            cursor = &cursor[next..];
        }
        if headers.is_empty() {
            for (col, text) in cells {
                if !text.is_empty() {
                    headers.insert(col, text);
                }
            }
        } else {
            let mut row = Row::new();
            for (col, text) in cells {
                if text.is_empty() {
                    continue;
                }
                if let Some(name) = headers.get(&col) {
                    row.insert(name.clone(), text);
                }
            }
            if !row.is_empty() {
                rows.push(row);
            }
        }
        rest = &rest[end + 6..];
    }
    rows
}

fn column_index(reference: &str) -> usize {
    let mut n = 0usize;
    for ch in reference.chars() {
        if ch.is_ascii_alphabetic() {
            n = n * 26 + (ch.to_ascii_uppercase() as usize - 'A' as usize + 1);
        } else {
            break;
        }
    }
    n.saturating_sub(1)
}

fn tags(xml: &str, name: &str) -> Vec<String> {
    let mut out = Vec::new();
    let needle = format!("<{name}");
    let mut rest = xml;
    while let Some(start) = rest.find(&needle) {
        rest = &rest[start..];
        let Some(end) = rest.find('>') else { break };
        out.push(rest[..=end].to_string());
        rest = &rest[end + 1..];
    }
    out
}

fn attr(tag: &str, name: &str) -> String {
    for pattern in [format!("{name}=\""), format!("{name}='")] {
        if let Some(start) = tag.find(&pattern) {
            let after = &tag[start + pattern.len()..];
            let quote = pattern.chars().last().unwrap();
            if let Some(end) = after.find(quote) {
                return unescape(&after[..end]);
            }
        }
    }
    // r:id
    let prefixed = format!(":{name}=\"");
    if let Some(start) = tag.find(&prefixed) {
        let after = &tag[start + prefixed.len()..];
        if let Some(end) = after.find('"') {
            return unescape(&after[..end]);
        }
    }
    String::new()
}

fn text_between(xml: &str, open: &str, close: &str) -> Option<String> {
    let start = xml.find(open)?;
    let after = &xml[start..];
    let gt = after.find('>')?;
    let rest = &after[gt + 1..];
    let end = rest.find(close)?;
    Some(unescape(&rest[..end]))
}

fn unescape(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_three_spill_sheets() {
        let bytes = include_bytes!("fixtures/spills_min.xlsx");
        let sheets = sheets_by_name(
            bytes,
            &["CALLS", "INCIDENT_COMMONS", "MATERIAL_INVOLVED"],
        )
        .unwrap();
        let calls = sheets.get("CALLS").unwrap();
        assert_eq!(calls[0].get("SEQNOS").map(String::as_str), Some("99"));
        assert_eq!(calls[0].get("RESPONSIBLE_STATE").map(String::as_str), Some("PA"));
        assert_eq!(
            sheets.get("INCIDENT_COMMONS").unwrap()[0]
                .get("LOCATION_COUNTY")
                .map(String::as_str),
            Some("Allegheny")
        );
        assert_eq!(
            sheets.get("MATERIAL_INVOLVED").unwrap()[0]
                .get("NAME_OF_MATERIAL")
                .map(String::as_str),
            Some("Diesel fuel")
        );
    }
}
