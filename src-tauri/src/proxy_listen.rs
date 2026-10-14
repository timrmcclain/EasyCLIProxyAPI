//! Where the proxy listens, whether that is reachable from other computers, and, when something else holds the port,
//! which program it is. Health check uses this; the general settings command doesn't expose host or port.

use std::net::TcpListener;
use std::process::Command;

use serde::Serialize;

use crate::core_config::read_installed_core_config_settings;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PortOwner {
    pid: u32,
    name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProxyListenStatus {
    host: String,
    port: u16,
    /// Listening on every interface (empty host or a wildcard address) or a non-loopback address.
    exposed: bool,
    /// The port is taken. Only meaningful while the proxy itself isn't running: then it's another program.
    port_in_use: bool,
    owner: Option<PortOwner>,
}

pub(crate) fn is_loopback(host: &str) -> bool {
    let host = host.trim();
    // Parse rather than match a "127." prefix, so a hostname such as 127.example.com isn't taken as local.
    matches!(host.to_ascii_lowercase().as_str(), "localhost" | "[::1]")
        || host.parse::<std::net::IpAddr>().is_ok_and(|address| address.is_loopback())
}

fn hidden(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// The PID listening on `port`, from `netstat -ano` output.
pub(crate) fn listening_pid(netstat: &str, port: u16) -> Option<u32> {
    let suffix = format!(":{port}");
    netstat.lines().find_map(|line| {
        let fields: Vec<&str> = line.split_whitespace().collect();
        // Proto  Local Address  Foreign Address  State  PID
        if fields.len() >= 5 && fields[0].eq_ignore_ascii_case("TCP") && fields[3].eq_ignore_ascii_case("LISTENING") && fields[1].ends_with(&suffix) {
            fields[4].parse().ok()
        } else {
            None
        }
    })
}

/// The image name from `tasklist /FO CSV /NH` output: `"name.exe","1234",...`.
pub(crate) fn tasklist_name(csv: &str) -> Option<String> {
    let first = csv.lines().next()?.trim();
    let name = first.strip_prefix('"')?.split('"').next()?;
    (!name.is_empty()).then(|| name.to_string())
}

fn port_owner(port: u16) -> Option<PortOwner> {
    // No "-p tcp": that lists IPv4 only, and the owner may be listening on [::]:port.
    let netstat = hidden(Command::new("netstat").arg("-ano")).output().ok()?;
    let pid = listening_pid(&String::from_utf8_lossy(&netstat.stdout), port)?;
    let tasklist = hidden(Command::new("tasklist").args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])).output().ok();
    let name = tasklist.and_then(|out| tasklist_name(&String::from_utf8_lossy(&out.stdout))).unwrap_or_else(|| "unknown".into());
    Some(PortOwner { pid, name })
}

fn check(host: String, port: u16) -> ProxyListenStatus {
    let bind_host = if host.trim().is_empty() { "0.0.0.0".to_string() } else { host.trim().trim_matches(['[', ']']).to_string() };
    // Access denied also means the proxy can't listen here: Windows reserves some port ranges (Hyper-V, WinNAT).
    let port_in_use = matches!(
        TcpListener::bind((bind_host.as_str(), port)),
        Err(error) if matches!(error.kind(), std::io::ErrorKind::AddrInUse | std::io::ErrorKind::PermissionDenied)
    );
    ProxyListenStatus {
        exposed: !is_loopback(&host),
        owner: if port_in_use { port_owner(port) } else { None },
        port_in_use,
        host,
        port,
    }
}

#[tauri::command]
pub(crate) async fn proxy_listen_status() -> Result<ProxyListenStatus, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let settings = read_installed_core_config_settings()?;
        Ok(check(settings.host, settings.port))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_and_exposed_hosts() {
        for host in ["127.0.0.1", "localhost", "::1", "[::1]", "127.0.0.2"] {
            assert!(is_loopback(host), "{host}");
        }
        for host in ["", "0.0.0.0", "::", "192.168.1.10", "127.example.com"] {
            assert!(!is_loopback(host), "{host}");
        }
    }

    #[test]
    fn finds_the_listening_pid_for_the_port_only() {
        let netstat = "
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1188
  TCP    127.0.0.1:83170        0.0.0.0:0              LISTENING       9
  TCP    127.0.0.1:8317         127.0.0.1:50000        ESTABLISHED     26036
  TCP    127.0.0.1:8317         0.0.0.0:0              LISTENING       26036
";
        assert_eq!(listening_pid(netstat, 8317), Some(26036));
        assert_eq!(listening_pid(netstat, 8318), None);
        // An IPv6-only listener, which "netstat -p tcp" would not have listed.
        assert_eq!(listening_pid("  TCP    [::]:8317              [::]:0                 LISTENING       4242", 8317), Some(4242));
    }

    #[test]
    fn reads_the_image_name_from_tasklist_csv() {
        assert_eq!(tasklist_name("\"node.exe\",\"4242\",\"Console\",\"1\",\"52,100 K\"\r\n").as_deref(), Some("node.exe"));
        assert_eq!(tasklist_name("INFO: No tasks are running which match the specified criteria.").as_deref(), None);
    }

    #[test]
    fn reports_a_taken_port() {
        let holder = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = holder.local_addr().unwrap().port();
        let status = check("127.0.0.1".into(), port);
        assert!(status.port_in_use);
        assert!(!status.exposed);
        drop(holder);
        assert!(!check("127.0.0.1".into(), port).port_in_use);
    }
}
