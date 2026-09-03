use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use std::{env, fs};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().collect();
    if args.len() != 4 { return Err("Usage: verify-update INSTALLER SIGNATURE PUBLIC_KEY".into()); }
    let data = fs::read(&args[1])?;
    let decode = |p: &str| -> Result<String, Box<dyn std::error::Error>> {
        Ok(String::from_utf8(STANDARD.decode(fs::read_to_string(p)?.trim())?)?)
    };
    let key = PublicKey::decode(&decode(&args[3])?)?;
    let signature = Signature::decode(&decode(&args[2])?)?;
    key.verify(&data, &signature, true)?;
    let mut tampered = data.clone();
    if tampered.is_empty() { return Err("Empty installer".into()); }
    tampered[0] ^= 1;
    if key.verify(&tampered, &signature, true).is_ok() { return Err("Tamper test failed".into()); }
    println!("SIGNATURE=PASS TAMPER_REJECTED=PASS bytes={}", data.len());
    Ok(())
}
