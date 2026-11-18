//! A short MQTT 3.1.1 subscribe, enough for a broker already on the LAN.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

#[derive(Clone, Debug)]
pub struct MqttMessage {
    pub topic: String,
    pub payload: String,
}

pub fn listen(host: &str, port: u16, topic: &str, wait: Duration) -> Result<Vec<MqttMessage>, String> {
    let mut stream = TcpStream::connect((host, port)).map_err(|_| {
        format!("Could not reach the MQTT broker at {host}:{port}.")
    })?;
    stream
        .set_read_timeout(Some(Duration::from_millis(400)))
        .ok();
    stream.set_write_timeout(Some(Duration::from_secs(5))).ok();
    stream
        .write_all(&connect_packet())
        .map_err(|_| "The MQTT broker did not accept a connection.".to_string())?;
    let _ = read_packet(&mut stream)?;
    stream
        .write_all(&subscribe_packet(topic))
        .map_err(|_| "Could not subscribe on the MQTT broker.".to_string())?;
    let deadline = std::time::Instant::now() + wait;
    let mut out = Vec::new();
    while std::time::Instant::now() < deadline && out.len() < 40 {
        match read_packet(&mut stream) {
            Ok(packet) => {
                if packet.first().copied() == Some(0x30) || packet.first().map(|byte| byte & 0xf0) == Some(0x30)
                {
                    if let Some(message) = publish(&packet) {
                        out.push(message);
                    }
                }
            }
            Err(_) => break,
        }
    }
    Ok(out)
}

fn connect_packet() -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&[0x00, 0x04]);
    body.extend_from_slice(b"MQTT");
    body.push(0x04);
    body.push(0x02);
    body.extend_from_slice(&15u16.to_be_bytes());
    let client = b"command-center";
    body.extend_from_slice(&(client.len() as u16).to_be_bytes());
    body.extend_from_slice(client);
    let mut packet = vec![0x10];
    packet.extend(remaining(body.len()));
    packet.extend(body);
    packet
}

fn subscribe_packet(topic: &str) -> Vec<u8> {
    let topic = topic.as_bytes();
    let mut body = vec![0x00, 0x01];
    body.extend_from_slice(&(topic.len() as u16).to_be_bytes());
    body.extend_from_slice(topic);
    body.push(0);
    let mut packet = vec![0x82];
    packet.extend(remaining(body.len()));
    packet.extend(body);
    packet
}

fn remaining(len: usize) -> Vec<u8> {
    let mut value = len;
    let mut out = Vec::new();
    loop {
        let mut byte = (value % 128) as u8;
        value /= 128;
        if value > 0 {
            byte |= 0x80;
        }
        out.push(byte);
        if value == 0 {
            break;
        }
    }
    out
}

fn read_packet(stream: &mut TcpStream) -> Result<Vec<u8>, String> {
    let mut header = [0u8; 1];
    stream.read_exact(&mut header).map_err(|_| "mqtt closed".to_string())?;
    let mut multiplier = 1usize;
    let mut length = 0usize;
    for _ in 0..4 {
        let mut byte = [0u8; 1];
        stream.read_exact(&mut byte).map_err(|_| "mqtt closed".to_string())?;
        length += (byte[0] & 0x7f) as usize * multiplier;
        if byte[0] & 0x80 == 0 {
            break;
        }
        multiplier *= 128;
    }
    let mut body = vec![0u8; length];
    if length > 0 {
        stream.read_exact(&mut body).map_err(|_| "mqtt closed".to_string())?;
    }
    let mut packet = vec![header[0]];
    packet.extend(body);
    Ok(packet)
}

fn publish(packet: &[u8]) -> Option<MqttMessage> {
    if packet.len() < 5 || packet[0] & 0xf0 != 0x30 {
        return None;
    }
    let mut index = 1;
    let mut multiplier = 1usize;
    let mut length = 0usize;
    while index < packet.len() {
        let byte = packet[index];
        index += 1;
        length += (byte & 0x7f) as usize * multiplier;
        if byte & 0x80 == 0 {
            break;
        }
        multiplier *= 128;
        if multiplier > 128 * 128 * 128 {
            return None;
        }
    }
    if index + 2 > packet.len() {
        return None;
    }
    let topic_len = u16::from_be_bytes([packet[index], packet[index + 1]]) as usize;
    index += 2;
    if index + topic_len > packet.len() {
        return None;
    }
    let topic = String::from_utf8_lossy(&packet[index..index + topic_len]).to_string();
    index += topic_len;
    let qos = (packet[0] >> 1) & 0x03;
    if qos > 0 {
        index += 2;
    }
    if index > packet.len() {
        return None;
    }
    let payload = String::from_utf8_lossy(&packet[index..]).trim().to_string();
    let _ = length;
    Some(MqttMessage { topic, payload })
}
