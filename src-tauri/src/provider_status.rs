//! Providers' public status pages, for the optional outage badges on Overview.
//! Only these fixed addresses are ever fetched; nothing from the page chooses a URL.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::core_runtime::build_http_client_with_proxy;
use crate::GuiConfigState;

/// Providers whose status page publishes the standard `status.json` feed.
const FEEDS: &[(&str, &str, &str)] = &[
    ("claude", "https://status.claude.com/api/v2/status.json", "https://status.claude.com"),
    ("codex", "https://status.openai.com/api/v2/status.json", "https://status.openai.com"),
];

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderStatus {
    provider: String,
    /// The feed's indicator: none, minor, major, critical or maintenance; "unknown" if it couldn't be read.
    indicator: String,
    description: String,
    page_url: String,
}

#[derive(Deserialize)]
struct Feed {
    status: FeedStatus,
}

#[derive(Deserialize)]
struct FeedStatus {
    indicator: String,
    description: String,
}

/// Reads one feed's body; anything unexpected becomes "unknown" rather than an outage.
fn parse_feed(provider: &str, page_url: &str, body: Option<&str>) -> ProviderStatus {
    let parsed = body.and_then(|text| serde_json::from_str::<Feed>(text).ok());
    let known = ["none", "minor", "major", "critical", "maintenance"];
    match parsed {
        Some(feed) if known.contains(&feed.status.indicator.as_str()) => ProviderStatus {
            provider: provider.to_string(),
            indicator: feed.status.indicator,
            description: feed.status.description.chars().take(160).collect(),
            page_url: page_url.to_string(),
        },
        _ => ProviderStatus {
            provider: provider.to_string(),
            indicator: "unknown".to_string(),
            description: String::new(),
            page_url: page_url.to_string(),
        },
    }
}

#[tauri::command]
pub(crate) async fn get_provider_status(
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<Vec<ProviderStatus>, String> {
    let proxy_url = gui_config_state.snapshot()?.proxy_url.clone();
    let client = build_http_client_with_proxy(
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(10)),
        &proxy_url,
        "Failed to create status client",
    )?;
    let mut statuses = Vec::with_capacity(FEEDS.len());
    for (provider, feed_url, page_url) in FEEDS {
        let body = match client.get(*feed_url).send().await {
            Ok(response) if response.status().is_success() => response.text().await.ok(),
            _ => None,
        };
        statuses.push(parse_feed(provider, page_url, body.as_deref()));
    }
    Ok(statuses)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_indicator_and_description() {
        let body = r#"{"page":{"id":"x"},"status":{"indicator":"major","description":"Partial outage"}}"#;
        let status = parse_feed("claude", "https://status.claude.com", Some(body));
        assert_eq!(status.indicator, "major");
        assert_eq!(status.description, "Partial outage");
    }

    #[test]
    fn treats_unreadable_or_unexpected_feeds_as_unknown_not_an_outage() {
        assert_eq!(parse_feed("codex", "u", None).indicator, "unknown");
        assert_eq!(parse_feed("codex", "u", Some("<html>")).indicator, "unknown");
        let odd = r#"{"status":{"indicator":"<script>","description":"x"}}"#;
        assert_eq!(parse_feed("codex", "u", Some(odd)).indicator, "unknown");
    }

    #[test]
    fn only_fetches_fixed_https_addresses() {
        assert!(FEEDS.iter().all(|(_, feed, page)| feed.starts_with("https://") && page.starts_with("https://")));
    }
}
