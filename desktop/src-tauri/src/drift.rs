//! `drift_fetch`: answer the server's local-URL capture fetches. A drift
//! compare of a localhost/private URL hands this app one request at a time,
//! already pinned to the capture's origin by the server — this side only
//! checks the scheme and the caps below (mirrors shared/drift.ts; keep the
//! two in step). Bodies travel base64 so binary resources survive the
//! JSON bridge.

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::collections::HashMap;
use std::time::Duration;

const MAX_BODY_BYTES: usize = 10 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(20);
const MAX_REDIRECTS: usize = 5;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriftFetchResult {
    ok: bool,
    status: Option<u16>,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
    error: Option<String>,
}

fn refused(message: &str) -> Result<DriftFetchResult, String> {
    Ok(DriftFetchResult {
        ok: false,
        status: None,
        headers: None,
        body: None,
        error: Some(message.to_string()),
    })
}

#[tauri::command]
pub async fn drift_fetch(
    url: String,
    method: Option<String>,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
) -> Result<DriftFetchResult, String> {
    let parsed = match reqwest::Url::parse(&url) {
        Ok(u) if u.scheme() == "http" || u.scheme() == "https" => u,
        _ => return refused("only http(s) requests are allowed"),
    };
    /* this command exists so a drift compare can reach the developer's own
       dev server: loopback only, never the LAN or the internet, or any page
       of the chosen server could browse the user's network through the app */
    if !is_loopback(&parsed) {
        return refused("only localhost / 127.0.0.1 can be fetched from this computer");
    }
    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= MAX_REDIRECTS || !is_loopback(attempt.url()) {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|e| e.to_string())?;
    let method = match method.as_deref().unwrap_or("GET").to_ascii_uppercase().as_str() {
        "GET" => reqwest::Method::GET,
        "HEAD" => reqwest::Method::HEAD,
        _ => return refused("only GET and HEAD are allowed"),
    };
    let mut req = client.request(method, parsed);
    for (name, value) in headers.unwrap_or_default() {
        if let (Ok(n), Ok(v)) = (
            name.parse::<reqwest::header::HeaderName>(),
            reqwest::header::HeaderValue::from_str(&value),
        ) {
            req = req.header(n, v);
        }
    }
    if let Some(b64) = body {
        let bytes = STANDARD
            .decode(b64)
            .map_err(|_| "bad request body".to_string())?;
        if bytes.len() > MAX_BODY_BYTES {
            return refused("request body too large");
        }
        req = req.body(bytes);
    }
    let mut resp = match req.send().await {
        Ok(r) => r,
        Err(e) => return refused(&format!("fetch failed: {e}")),
    };
    let status = resp.status().as_u16();
    let mut out_headers = HashMap::new();
    for (name, value) in resp.headers() {
        /* the page's renderer cannot act on a Set-Cookie here anyway */
        if name == reqwest::header::SET_COOKIE {
            continue;
        }
        if let Ok(v) = value.to_str() {
            out_headers
                .entry(name.as_str().to_string())
                .and_modify(|existing: &mut String| {
                    existing.push_str(", ");
                    existing.push_str(v);
                })
                .or_insert_with(|| v.to_string());
        }
    }
    if resp.content_length().unwrap_or(0) as usize > MAX_BODY_BYTES {
        return refused("response too large");
    }
    let mut bytes = Vec::new();
    loop {
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                if bytes.len() + chunk.len() > MAX_BODY_BYTES {
                    return refused("response too large");
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(e) => return refused(&format!("fetch failed: {e}")),
        }
    }
    Ok(DriftFetchResult {
        ok: true,
        status: Some(status),
        headers: Some(out_headers),
        body: Some(STANDARD.encode(&bytes)),
        error: None,
    })
}

/// localhost, 127.0.0.0/8 — the developer's own machine, nothing else.
fn is_loopback(url: &reqwest::Url) -> bool {
    match url.host_str() {
        Some(h) if h.eq_ignore_ascii_case("localhost") => true,
        Some(h) => h.parse::<std::net::Ipv4Addr>().map(|ip| ip.is_loopback()).unwrap_or(false),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::is_loopback;

    #[test]
    fn only_loopback_urls_pass() {
        for ok in ["http://localhost:4321/", "http://127.0.0.1:3000/x", "http://127.1.2.3/"] {
            assert!(is_loopback(&ok.parse().unwrap()), "{ok}");
        }
        for no in ["http://192.168.1.10/", "https://example.com/", "http://10.0.0.1/", "http://169.254.169.254/"] {
            assert!(!is_loopback(&no.parse().unwrap()), "{no}");
        }
    }
}
