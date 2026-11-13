//! `live_*` commands: render a dev-server page offscreen and hand its DOM
//! back so the app can freeze it into a static frame (src/lib/liveFrame.ts).
//! The page only exists on this machine — a hosted server cannot reach a
//! Mac's localhost — so the capture has to happen here, in a hidden webview.
//!
//! Two commands split the work because `eval` returns nothing: `live_snapshot`
//! opens the hidden window, and the capture script it injects answers through
//! `live_snapshot_done` — the only command that window's page may invoke
//! (capabilities/live-snapshot.json).
//!
//! The URL is checked natively for the same reason repo.rs sandboxes every
//! read: commands can be invoked by anything that reaches IPC, so this side
//! re-proves the rules shared/liveFrame.ts's parseLiveUrl applies in the app
//! — http(s) on `localhost`/`*.localhost`, 127.0/8 or [::1], no credentials —
//! before the webview is even created. Keep `loopback` in step with it.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::oneshot;

/// Connect, load and settle a page within this or the caller hears "the page
/// took too long" — a dead dev server must fail the snapshot, not hang it.
const SNAPSHOT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
/// A captured DOM bigger than this is refused before it crosses IPC; the
/// app's own frame cap (shared/liveFrame.ts's SNAPSHOT_MAX_CHARS) is stricter.
const MAX_SNAPSHOT_BYTES: usize = 8 * 1024 * 1024;
/// Let the page finish client-side rendering after `load` before reading its
/// DOM — SPAs deliver their markup late.
const SETTLE_MS: u32 = 400;

/// The hidden window posts its DOM back through this script, eval'd once the
/// page finishes loading. `__TAURI_INTERNALS__` is injected into every
/// webview the shell makes (withGlobalTauri); the invoke it carries only
/// lands because live-snapshot.json grants this window's loopback origins
/// `allow-live-snapshot-done` and nothing else.
const CAPTURE_JS: &str = r#"setTimeout(function () {
  function done(payload) {
    try { window.__TAURI_INTERNALS__.invoke('live_snapshot_done', payload) } catch (e) {}
  }
  try {
    done({ html: '<!doctype html>\n' + document.documentElement.outerHTML })
  } catch (e) {
    done({ error: String(e) })
  }
}, %SETTLE%);"#;

/// What `live_snapshot` answers: the page's serialized DOM, scripts included
/// — the caller scrubs them (shared/liveFrame.ts's sanitizeSnapshotHtml).
#[derive(Serialize)]
pub struct Snapshot {
    html: String,
}

/// Snapshots in flight: window label → the channel `live_snapshot` awaits.
/// `live_snapshot_done` looks the calling window's label up here.
#[derive(Default)]
pub struct LiveState(Mutex<HashMap<String, oneshot::Sender<Result<String, String>>>>);

/// http(s) only, loopback hosts only: `localhost` and its subdomains,
/// 127.0.0.0/8. The url crate has already normalized the host — an integer
/// or hex `127.1` arrives as the dotted form — and userinfo in a live URL
/// is never legitimate.
fn loopback(url: &tauri::Url) -> bool {
    if url.scheme() != "http" && url.scheme() != "https" {
        return false;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let Some(host) = url.host_str() else { return false };
    if host == "localhost" || host.ends_with(".localhost") {
        return true;
    }
    host.parse::<std::net::Ipv4Addr>().is_ok_and(|ip| ip.is_loopback())
}

#[tauri::command]
pub async fn live_snapshot(
    app: AppHandle,
    state: State<'_, LiveState>,
    url: String,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<Snapshot, String> {
    let target =
        tauri::Url::parse(url.trim()).map_err(|_| "not a URL".to_string())?;
    if !loopback(&target) {
        return Err("only loopback URLs (localhost, 127.x.x.x or [::1]) can be snapshotted".to_string());
    }
    let label = format!("live-snapshot-{}", uuid::Uuid::new_v4());
    let (tx, rx) = oneshot::channel();
    state.inner().0.lock().unwrap().insert(label.clone(), tx);

    let w = width.unwrap_or(1280.0).clamp(50.0, 10000.0);
    let h = height.unwrap_or(800.0).clamp(50.0, 10000.0);
    let window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(target))
        .title("")
        .inner_size(w, h)
        .visible(false)
        .on_page_load(move |webview, payload| {
            if payload.event() == PageLoadEvent::Finished {
                let _ = webview.eval(&CAPTURE_JS.replace("%SETTLE%", &SETTLE_MS.to_string()));
            }
        })
        .build();
    let window = match window {
        Ok(w) => w,
        Err(e) => {
            state.inner().0.lock().unwrap().remove(&label);
            return Err(format!("couldn't open the snapshot window: {e}"));
        }
    };

    let result = match tokio::time::timeout(SNAPSHOT_TIMEOUT, rx).await {
        Ok(Ok(result)) => result,
        /* the sender dropped: the window went away before the page answered */
        Ok(Err(_)) => Err("the snapshot window was closed".to_string()),
        Err(_) => Err("the page took too long to answer".to_string()),
    };
    /* whichever way it ended, the hidden window and the pending entry go —
       a `live_snapshot_done` landing after the timeout finds nothing and is
       ignored */
    let _ = window.close();
    state.inner().0.lock().unwrap().remove(&label);
    result.map(|html| Snapshot { html })
}

/// The capture script's only way back: post the DOM (or its error) to the
/// snapshot waiting on this window's label. Invoked by the page inside the
/// hidden webview — never by the app — so it lives on its own capability.
#[tauri::command]
pub async fn live_snapshot_done(
    window: WebviewWindow,
    state: State<'_, LiveState>,
    html: Option<String>,
    error: Option<String>,
) -> Result<(), String> {
    let label = window.label().to_string();
    let tx = state.inner().0.lock().unwrap().remove(&label);
    let _ = window.close();
    if let Some(tx) = tx {
        let result = match (html, error) {
            (Some(html), _) if html.len() > MAX_SNAPSHOT_BYTES => {
                Err("the page is too large to snapshot".to_string())
            }
            (Some(html), _) => Ok(html),
            (None, Some(error)) => Err(error),
            _ => Err("the page returned nothing".to_string()),
        };
        let _ = tx.send(result);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(raw: &str) -> bool {
        loopback(&tauri::Url::parse(raw).unwrap())
    }

    #[test]
    fn accepts_loopback() {
        for url in [
            "http://localhost:4321/contact",
            "https://localhost",
            "http://app.localhost:3000",
            "http://127.0.0.1:8080/a?b=c#d",
        ] {
            assert!(ok(url), "{url}");
        }
    }

    #[test]
    fn rejects_everything_else() {
        for url in [
            "http://example.com",
            "https://192.168.1.20:3000",
            "http://10.0.0.4",
            "http://0.0.0.0:3000",
            "http://[::1]:5173",
            "file:///etc/hosts",
            "javascript:alert(1)",
            "http://user:pw@localhost:3000",
            "http://localhost.attacker.com",
            "ftp://localhost/x",
        ] {
            assert!(!ok(url), "{url}");
        }
    }

    #[test]
    fn parser_normalizes_sneaky_ipv4() {
        /* integer and hex spellings of 127.0.0.1 normalize to the dotted
           form, so they pass — the loopback check never matches strings */
        assert!(ok("http://2130706433:3000"));
        assert!(ok("http://0x7f000001"));
        assert!(ok("http://127.1:3000"));
        /* a short-form 128.x still is not loopback */
        assert!(!ok("http://0x80000001"));
    }
}
