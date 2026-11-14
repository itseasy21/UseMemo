use crate::error::{AppError, AppResult};

use super::types::RawSynthesis;

const MAX_RESPONSE_BYTES: usize = 1024 * 1024;

/// Parse the LiteRT-LM response. Tolerates code fences and leading/trailing prose,
/// but still requires one complete JSON object.
pub fn parse_synthesis(raw: &str) -> AppResult<RawSynthesis> {
    if raw.len() > MAX_RESPONSE_BYTES {
        return Err(AppError::Synthesis(
            "model response is unexpectedly large".into(),
        ));
    }
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::Synthesis(
            "model returned an empty response".into(),
        ));
    }

    let without_fences = strip_code_fences(trimmed);
    let start = without_fences
        .find('{')
        .ok_or_else(|| AppError::Synthesis("model response contains no JSON object".into()))?;
    let end = without_fences.rfind('}').ok_or_else(|| {
        AppError::Synthesis("model response contains no complete JSON object".into())
    })?;
    if end <= start {
        return Err(AppError::Synthesis(
            "model response JSON boundaries are invalid".into(),
        ));
    }

    let json = &without_fences[start..=end];
    let parsed: RawSynthesis = serde_json::from_str(json)
        .map_err(|error| AppError::Synthesis(format!("invalid synthesis JSON: {error}")))?;
    Ok(parsed)
}

fn strip_code_fences(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for line in value.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") {
            continue;
        }
        output.push_str(line);
        output.push('\n');
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bare_json() {
        let raw = r#"{"summary":[{"content":"ok","evidenceIds":["T-00:40"]}],"decisions":[],"actionItems":[]}"#;
        let parsed = parse_synthesis(raw).unwrap();
        assert_eq!(parsed.summary.len(), 1);
        assert_eq!(parsed.summary[0].evidence_ids, vec!["T-00:40"]);
    }

    #[test]
    fn parses_fenced_json_with_prose_and_camel_case_aliases() {
        let raw = r#"
        Here is the result:
        ```json
        {
          "summary": [],
          "decisions": [],
          "actionItems": [
            {"content":"Send sheet","owner":"Alex","deadline":"Wednesday","evidenceIds":["T-09:20"]}
          ]
        }
        ```
        Done.
        "#;
        let parsed = parse_synthesis(raw).unwrap();
        assert_eq!(parsed.action_items.len(), 1);
        assert_eq!(parsed.action_items[0].owner.as_deref(), Some("Alex"));
        assert_eq!(parsed.action_items[0].evidence_ids, vec!["T-09:20"]);
    }

    #[test]
    fn tolerates_snake_case_from_small_models() {
        let raw = r#"{"summary":[],"decisions":[],"action_items":[{"content":"x","evidence_ids":["N-L1"]}]}"#;
        let parsed = parse_synthesis(raw).unwrap();
        assert_eq!(parsed.action_items[0].evidence_ids, vec!["N-L1"]);
    }

    #[test]
    fn rejects_empty_or_non_json_responses() {
        assert!(parse_synthesis("").is_err());
        assert!(parse_synthesis("I could not find anything.").is_err());
        assert!(parse_synthesis("```json\n{oops}\n```").is_err());
    }
}
