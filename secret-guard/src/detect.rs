//! Credential detectors. Every detector is a high-confidence pattern: a known
//! key prefix, a PEM block, a JWT, a password inside a connection string, or a
//! `password=` style assignment with a value that doesn't look like code.
//! There is deliberately no generic "random-looking string" detector.

use regex::Regex;
use std::sync::OnceLock;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Finding {
    /// Stable machine name, e.g. `github_token`.
    pub kind: &'static str,
    /// Byte range of the secret itself inside the scanned text.
    pub start: usize,
    pub end: usize,
}

struct Detector {
    kind: &'static str,
    regex: Regex,
    /// Capture group holding the secret (0 = the whole match).
    group: usize,
    /// Reject matches glued to surrounding token characters, so random
    /// substrings of base64 blobs (images, encoded files) don't count.
    bounded: bool,
    /// Extra check on the captured secret.
    validate: fn(&str) -> bool,
}

/// The END marker names the same key type as the BEGIN marker.
fn same_pem_type(block: &str) -> bool {
    let kind = |marker: &str| {
        let rest = &block[block.find(marker).map_or(0, |i| i + marker.len())..];
        rest.split("PRIVATE KEY").next().unwrap_or("").to_string()
    };
    kind("-----BEGIN ") == kind("-----END ")
}

/// A JWT whose payload isn't a well-known documentation sample (jwt.io's "John Doe" and friends).
fn real_jwt(token: &str) -> bool {
    let Some(payload) = token.split('.').nth(1) else { return false };
    let decoded = base64_url_decode(payload);
    let text = String::from_utf8_lossy(&decoded).to_ascii_lowercase();
    text.starts_with('{') && !["john doe", "\"1234567890\"", "example", "test", "dummy", "sample"].iter().any(|word| text.contains(word))
}

fn base64_url_decode(text: &str) -> Vec<u8> {
    let value = |c: u8| match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'-' | b'+' => Some(62),
        b'_' | b'/' => Some(63),
        _ => None,
    };
    let (mut out, mut buffer, mut bits) = (Vec::new(), 0u32, 0);
    for six in text.bytes().map_while(value) {
        buffer = (buffer << 6) | u32::from(six);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    out
}

/// A connection-string password, URL-decoded first (`p%40ss` is `p@ss`). It has to look like a real password:
/// `root:admin123@localhost` and `default:mypassword1@` fill docs and test setups.
fn connection_password(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                decoded.push((high * 16 + low) as u8);
                i += 3;
                continue;
            }
        }
        decoded.push(bytes[i]);
        i += 1;
    }
    std::str::from_utf8(&decoded).is_ok_and(strong_password)
}

fn detectors() -> &'static [Detector] {
    static DETECTORS: OnceLock<Vec<Detector>> = OnceLock::new();
    DETECTORS.get_or_init(|| {
        let d = |kind, pattern: &str, group, bounded, validate: fn(&str) -> bool| Detector {
            kind,
            regex: Regex::new(pattern).expect("detector pattern"),
            group,
            bounded,
            validate,
        };
        vec![
            d("github_token", r"gh[pousr]_[A-Za-z0-9]{36,251}", 0, true, not_placeholder),
            d("github_token", r"github_pat_[A-Za-z0-9_]{82}", 0, true, not_placeholder),
            // `sid` is a claude.ai session key.
            d("anthropic_key", r"sk-ant-(?:api|admin|oat|sid)\d{2}-[A-Za-z0-9_\-]{80,}", 0, true, not_placeholder),
            d("openrouter_key", r"sk-or-v1-[0-9a-f]{64}", 0, true, not_placeholder),
            d("openai_key", r"sk-(?:proj|svcacct|admin)-[A-Za-z0-9_\-]{40,}", 0, true, not_placeholder),
            d("xai_key", r"xai-[A-Za-z0-9]{80}", 0, true, not_placeholder),
            d("groq_key", r"gsk_[A-Za-z0-9]{52}", 0, true, not_placeholder),
            d("gitlab_token", r"glpat-[0-9A-Za-z_\-]{20,}", 0, true, not_placeholder),
            d("huggingface_token", r"hf_[A-Za-z]{34}", 0, true, not_placeholder),
            d("npm_token", r"npm_[A-Za-z0-9]{36}", 0, true, not_placeholder),
            d("google_oauth", r"GOCSPX-[A-Za-z0-9_\-]{28}|ya29\.[0-9A-Za-z_\-]{30,}", 0, true, not_placeholder),
            d("slack_webhook", r"https://hooks\.slack\.com/services/T[A-Z0-9]{8,}/B[A-Z0-9]{8,}/[A-Za-z0-9]{24}", 0, false, not_placeholder),
            d("openai_key", r"sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}", 0, true, not_placeholder),
            d("google_api_key", r"AIza[0-9A-Za-z_\-]{35}", 0, true, not_placeholder),
            d("aws_access_key", r"(?:AKIA|ASIA)[0-9A-Z]{16}", 0, true, not_placeholder),
            d("slack_token", r"xox[abposr]-[0-9A-Za-z\-]{10,}", 0, true, not_placeholder),
            d("stripe_key", r"(?:sk|rk)_live_[0-9A-Za-z]{24,}", 0, true, not_placeholder),
            d("azure_storage_key", r"AccountKey=([A-Za-z0-9+/]{86}==)", 1, false, not_placeholder),
            d("azure_client_secret", r"[A-Za-z0-9_~.\-]{3}\dQ~[A-Za-z0-9_~.\-]{31,34}", 0, true, not_placeholder),
            d(
                "private_key",
                // The body is base64, PEM headers and (in JSON) `\n` escapes, at most 8 KB. No quotes, so one
                // key can't stretch from a BEGIN marker in one string to an END marker in another.
                r"-----BEGIN (RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----[A-Za-z0-9+/=\s\\:,.\-]{20,8192}?-----END (RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----",
                0,
                false,
                same_pem_type,
            ),
            d("jwt", r"eyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{16,}", 0, true, real_jwt),
            d(
                "connection_string_password",
                // ASCII-only classes keep this on the regex crate's fast path. The user may be empty (`redis://:pw@`).
                r"(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?|mssql|sqlserver)://[A-Za-z0-9._%+~\-]{0,64}:([!#$%&()*+,.0-9;=?A-Z\[\]^_a-z{|}~\-]{3,128})@",
                1,
                false,
                connection_password,
            ),
            d(
                "password_assignment",
                // Only password-style keys: API keys and tokens are caught by their prefixes above, and
                // `api_key: "test-key"` is everywhere in code. The key may follow a `\n` escape (each .env line
                // inside a JSON body) or a name prefix (`DB_PASSWORD`, `AZURE_CLIENT_SECRET`); `&` ends a value,
                // as in a URL query.
                r"(?i)(?:^|[^A-Za-z0-9]|\\[ntr])(?:[A-Za-z0-9]+_)*(?:password|passwd|client_secret|aws_secret_access_key)(?:\\?[\x22'])?\s*[:=]\s*(?:\\?[\x22'])?([^\s\x22'\\,;&]{8,128})",
                1,
                false,
                strong_password,
            ),
        ]
    })
}

/// Rejects obvious documentation values: `ghp_xxxx…`, `AKIA…EXAMPLE`, etc.
fn not_placeholder(secret: &str) -> bool {
    let lower = secret.to_ascii_lowercase();
    if ["example", "placeholder", "dummy", "redacted", "xxxxxx", "your_", "your-", "abcdefgh", "12345678"]
        .iter()
        .any(|word| lower.contains(word))
    {
        return false;
    }
    let mut distinct: Vec<u8> = secret.bytes().collect();
    distinct.sort_unstable();
    distinct.dedup();
    distinct.len() >= 8
}

/// A password value has to look like a value, not code or a template.
fn plausible_password(value: &str) -> bool {
    if !not_placeholder(value) {
        return false;
    }
    if value.bytes().any(|b| b"()[]{}<>$%*`".contains(&b)) {
        return false;
    }
    let has_letter = value.bytes().any(|b| b.is_ascii_alphabetic());
    let has_other = value.bytes().any(|b| !b.is_ascii_alphabetic());
    if !has_letter || !has_other {
        return false;
    }
    // `settings.SECRET_KEY`, `os.environ`, `self.password`: identifiers and property paths.
    let first = value.as_bytes()[0];
    let identifier = (first.is_ascii_alphabetic() || first == b'_')
        && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.');
    if identifier && (value.contains('.') || value.contains('_') || value.bytes().all(|b| !b.is_ascii_digit())) {
        return false;
    }
    let lower = value.to_ascii_lowercase();
    !["changeme", "password", "required", "optional", "undefined", "process.env", "os.environ"]
        .iter()
        .any(|word| lower.starts_with(word))
}

/// For `password = …` assignments: test fixtures are full of these, so the
/// value must also look like a real, strong password.
fn strong_password(value: &str) -> bool {
    if value.len() < 10 || !plausible_password(value) {
        return false;
    }
    let classes = [
        value.bytes().any(|b| b.is_ascii_lowercase()),
        value.bytes().any(|b| b.is_ascii_uppercase()),
        value.bytes().any(|b| b.is_ascii_digit()),
        // ASCII punctuation only: in "Contraseña" the ñ is a letter, not a symbol.
        value.bytes().any(|b| b.is_ascii_punctuation()),
    ];
    if !value.is_ascii() {
        return false;
    }
    if classes.iter().filter(|c| **c).count() < 3 {
        return false;
    }
    let lower = value.to_ascii_lowercase();
    !["test", "fake", "sample", "demo", "secret", "token", "passw", "pa55w", "hunter", "letmein", "admin", "123456"]
        .iter()
        .any(|word| lower.contains(word))
}

fn is_token_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'+' || b == b'/'
}

/// Finds credentials in `text`. Results are sorted and never overlap.
pub fn scan(text: &str) -> Vec<Finding> {
    let bytes = text.as_bytes();
    let mut found = Vec::new();
    for detector in detectors() {
        for caps in detector.regex.captures_iter(text) {
            let Some(m) = caps.get(detector.group) else { continue };
            if detector.bounded {
                // `\n`, `\t` or `\r` escapes in a JSON body end at a letter but are a boundary.
                let escaped = m.start() >= 2 && bytes[m.start() - 2] == b'\\' && b"ntr".contains(&bytes[m.start() - 1]);
                // A match can't start inside an escape: in `\rk_live_…` the `r` belongs to `\r`, and redacting
                // from it would leave a lone `\` and invalid JSON.
                // An even run (`\\`) is an escaped backslash, so the match after it is real.
                let backslashes = bytes[..m.start()].iter().rev().take_while(|b| **b == b'\\').count();
                if backslashes % 2 == 1 {
                    continue;
                }
                let before = if escaped { None } else { m.start().checked_sub(1).map(|i| bytes[i]) };
                let after = bytes.get(m.end()).copied();
                if before.is_some_and(is_token_byte) || after.is_some_and(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
                    continue;
                }
            }
            if !(detector.validate)(m.as_str()) {
                continue;
            }
            found.push(Finding { kind: detector.kind, start: m.start(), end: m.end() });
        }
    }
    found.sort_by_key(|f| (f.start, std::cmp::Reverse(f.end)));
    let mut merged: Vec<Finding> = Vec::with_capacity(found.len());
    for finding in found {
        if merged.last().is_some_and(|last| finding.start < last.end) {
            continue;
        }
        merged.push(finding);
    }
    merged
}

#[cfg(test)]
mod tests {
    use super::*;

    // Fixtures are assembled at runtime so no realistic-looking credential
    // ever appears in the source (and trips push protection).
    fn rand_like(n: usize) -> String {
        let alphabet = b"aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY";
        (0..n).map(|i| alphabet[(i * 7 + i / 3) % alphabet.len()] as char).collect()
    }
    fn kinds(text: &str) -> Vec<&'static str> {
        scan(text).into_iter().map(|f| f.kind).collect()
    }

    #[test]
    fn finds_known_key_formats() {
        let gh = format!("{}{}", "gh", "p_") + &rand_like(36);
        assert_eq!(kinds(&format!("token is {gh} ok")), vec!["github_token"]);
        let ant = format!("sk-{}-api03-{}", "ant", rand_like(90));
        assert_eq!(kinds(&format!("\"{ant}\"")), vec!["anthropic_key"]);
        let oai = format!("sk-{}-{}", "proj", rand_like(60));
        assert_eq!(kinds(&oai), vec!["openai_key"]);
        let google = format!("{}{}", "AI", "za") + &rand_like(35);
        assert_eq!(kinds(&format!("key={google}&x")), vec!["google_api_key"]);
        let aws = format!("{}{}", "AK", "IA") + "Q7ZK3M5N2P8R4T6V";
        assert_eq!(kinds(&format!("id {aws}\n")), vec!["aws_access_key"]);
        let stripe = format!("sk_{}_", "live") + &rand_like(30);
        assert_eq!(kinds(&stripe), vec!["stripe_key"]);
    }

    #[test]
    fn finds_tokens_in_escaped_json_and_longer_formats() {
        let pat = format!("{}{}", "github", "_pat_") + &rand_like(82);
        let header = format!(r#"{{\"Authorization\": \"Bearer {pat}\"}}"#);
        assert_eq!(kinds(&header), vec!["github_token"]);
        let after_newline = format!(r"line one\n{}{}{}", "gh", "s_", rand_like(40));
        assert_eq!(kinds(&after_newline), vec!["github_token"]);
        let sequence = format!("{}{}", "gh", "p_") + "abcdefghijklmnopqrstuvwxyz0123456789";
        assert!(scan(&sequence).is_empty(), "alphabet sequences are documentation examples");
    }

    #[test]
    fn pem_markers_in_separate_strings_are_not_one_key() {
        let (begin, end) = ("-----BEGIN PRIVATE KEY-----", "-----END PRIVATE KEY-----");
        assert!(scan(&format!(r#"const B = "{begin}"; const E = "{end}";"#)).is_empty());
        let messages = format!(r#"{{"a":"{begin}","b":"{}","c":"{end}"}}"#, "x".repeat(40));
        assert!(scan(&messages).is_empty(), "a BEGIN in one message and an END in another");
        let mismatched = format!("-----BEGIN RSA PRIVATE KEY-----\\n{}\\n-----END EC PRIVATE KEY-----", rand_like(64));
        assert!(scan(&mismatched).is_empty(), "END type must match BEGIN type");
    }

    #[test]
    fn finds_passwords_on_every_env_line_and_in_prefixed_names() {
        let env = r#"{"content":"HOST=db\nDB_PASSWORD=Kq7!vR2mZp26\nAZURE_CLIENT_SECRET=9fQ2-xL7pR4wZ"}"#;
        assert_eq!(kinds(env), vec!["password_assignment", "password_assignment"]);
        let query = "https://x.test/login?password=Kq7!vR2mZp26&user=bob";
        let found = scan(query);
        assert_eq!(&query[found[0].start..found[0].end], "Kq7!vR2mZp26", "a value stops at &");
    }

    #[test]
    fn connection_strings_need_a_real_password() {
        assert!(scan("mongodb://root:admin123@localhost:27017").is_empty());
        assert!(scan("redis://default:mypassword1@cache:6379").is_empty());
        let empty_user = "redis://:Tr0ub4dor-77@cache:6379";
        assert_eq!(&empty_user[scan(empty_user)[0].start..scan(empty_user)[0].end], "Tr0ub4dor-77");
        assert_eq!(kinds("postgres://app:Tr0ub4dor%2177@db/main"), vec!["connection_string_password"], "URL-encoded");
    }

    #[test]
    fn documentation_jwts_are_ignored() {
        let b64 = |text: &str| {
            let table = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
            let mut out = String::new();
            for chunk in text.as_bytes().chunks(3) {
                let n = chunk.iter().fold(0u32, |acc, b| (acc << 8) | u32::from(*b)) << (8 * (3 - chunk.len()));
                for i in 0..=chunk.len() {
                    out.push(table[((n >> (18 - 6 * i)) & 63) as usize] as char);
                }
            }
            out
        };
        let header = b64(r#"{"alg":"HS256","typ":"JWT"}"#);
        let sample = format!("{header}.{}.{}", b64(r#"{"sub":"1234567890","name":"John Doe","iat":1516239022}"#), rand_like(43));
        assert!(scan(&sample).is_empty());
        let real = format!("{header}.{}.{}", b64(r#"{"sub":"u_8f2k","tenant":"acme-prod","exp":1792075015}"#), rand_like(43));
        assert_eq!(kinds(&real), vec!["jwt"]);
    }

    #[test]
    fn a_match_never_starts_inside_an_escape() {
        let stripe = format!("{}{}", "rk_", "live_") + &rand_like(30);
        // `\r` followed by `k_live…`: the `r` belongs to the escape, so there's no key here.
        assert!(scan(&format!(r"line\{stripe}")).is_empty());
        // After an escaped backslash (`\\`) the key is real.
        assert_eq!(kinds(&format!(r"C:\\{stripe}")), vec!["stripe_key"]);
    }

    #[test]
    fn finds_more_provider_formats() {
        let hex64: String = (0..64).map(|i| b"0123456789abcdef"[(i * 7 + 3) % 16] as char).collect();
        assert_eq!(kinds(&format!("{}{hex64}", "sk-or-v1-")), vec!["openrouter_key"]);
        assert_eq!(kinds(&(format!("{}{}", "gl", "pat-") + &rand_like(20))), vec!["gitlab_token"]);
        assert_eq!(kinds(&(format!("{}{}", "gs", "k_") + &rand_like(52))), vec!["groq_key"]);
        assert_eq!(kinds(&(format!("{}{}", "GOC", "SPX-") + &rand_like(28))), vec!["google_oauth"]);
    }

    #[test]
    fn translations_are_not_passwords() {
        assert!(scan(r#"const es = { password: "Contraseña" };"#).is_empty());
        assert!(scan(r#"{"password": "Mot de passe"}"#).is_empty());
    }

    #[test]
    fn finds_pem_blocks_inside_json_strings() {
        let pem = format!(
            "-----BEGIN {} KEY-----\\n{}\\n{}\\n-----END {} KEY-----",
            "PRIVATE",
            rand_like(64),
            rand_like(64),
            "PRIVATE"
        );
        let body = format!("{{\"content\":\"here: {pem}\"}}");
        let found = scan(&body);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].kind, "private_key");
        assert_eq!(&body[found[0].start..found[0].end], pem);
    }

    #[test]
    fn finds_passwords_in_connection_strings_and_assignments() {
        let url = "postgres://app:Tr0ub4dor-77@db.internal:5432/main";
        let found = scan(url);
        assert_eq!(found.len(), 1);
        assert_eq!(&url[found[0].start..found[0].end], "Tr0ub4dor-77");

        let ado = "Server=sql01;Database=crm;User Id=sa;Password=Kq7!vR2mZp26;";
        let found = scan(ado);
        assert_eq!(found.len(), 1);
        assert_eq!(&ado[found[0].start..found[0].end], "Kq7!vR2mZp26");

        let escaped = r#"{\"client_secret\": \"9fQ2-xL7pR4wZ\"}"#;
        assert_eq!(kinds(escaped), vec!["password_assignment"]);
    }

    #[test]
    fn ignores_code_templates_and_placeholders() {
        let ordinary = [
            "password = request.form[\"password\"]",
            "secret_key = settings.SECRET_KEY",
            "PASSWORD=${DB_PASSWORD}",
            "api_key: <your api key>",
            "password: str = Field(min_length=8)",
            "const password = process.env.DB_PASSWORD;",
            "postgres://user:password@localhost/db",
            "mysql://root:${MYSQL_ROOT_PASSWORD}@db/app",
            "AKIAIOSFODNN7EXAMPLE",
            "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
            "password_hash = bcrypt(password)",
            "if (password.length < 12) return false;",
            "access_token = response.json()['access_token']",
            "def check_password(password: str) -> bool:",
            "the apikey parameter is required",
            "$env:PWD",
            // Test fixtures seen in real code.
            r#"APIKey: "sk-test-key1""#,
            r#"api_key: "config-key""#,
            r#"password: "Passw0rd!2024""#,
            r#"password = "testpassword1""#,
            r#"\"access_token\": \"token-abc\""#,
        ];
        for text in ordinary {
            assert!(scan(text).is_empty(), "false positive on: {text}");
        }
    }

    #[test]
    fn ignores_substrings_of_base64_blobs() {
        // A long base64 run that happens to contain key-like substrings.
        let google_like = format!("{}{}", "AI", "za") + &rand_like(35);
        let blob = format!("data:image/png;base64,iVBORw0KGgo{}{}QmCC", google_like, rand_like(40));
        assert!(scan(&blob).is_empty());
    }

    #[test]
    fn results_never_overlap() {
        let gh = format!("{}{}", "gh", "p_") + &rand_like(36);
        let text = format!("password={gh}");
        let found = scan(&text);
        for pair in found.windows(2) {
            assert!(pair[0].end <= pair[1].start);
        }
        assert!(!found.is_empty());
    }
}
