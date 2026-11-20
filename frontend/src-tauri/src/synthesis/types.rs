use serde::{Deserialize, Serialize};

pub const ITEM_SUMMARY: &str = "summary";
pub const ITEM_DECISION: &str = "decision";
pub const ITEM_ACTION: &str = "action_item";
pub const OWNER_UNASSIGNED: &str = "Unassigned";
pub const DEADLINE_UNSPECIFIED: &str = "Not specified";

/// Strict GBNF grammar constraining local `llama.cpp` decoding to a single
/// valid JSON object whose sections are arrays of `RawItem` objects carrying
/// `"content"` and `"evidenceIds"`.
pub const JSON_OBJECT_GBNF: &str = r#"
root     ::= ws object ws
object   ::= "{" ws (section ("," ws section)*)? "}" ws
section  ::= string ":" ws "[" ws (item ("," ws item)*)? "]" ws
item     ::= "{" ws "\"content\"" ws ":" ws string ("," ws optfield)* "," ws "\"evidenceIds\"" ws ":" ws strarray "}" ws
optfield ::= ("\"rationale\"" | "\"owner\"" | "\"deadline\"") ws ":" ws (string | "null" ws)
strarray ::= "[" ws string ("," ws string)* "]" ws
string   ::= "\"" (
  [^"\\\x7F\x00-\x1F] |
  "\\" (["\\/bfnrt] | "u" [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F])
)* "\"" ws
ws       ::= ([ \t\n\r])*
"#;

/// Shape emitted by the local SLM. Aliases accept common camelCase/snake_case
/// drift AND custom domain sections (e.g. Clinical SOAP) without weakening the
/// evidence contract.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawSynthesis {
    #[serde(default)]
    pub summary: Vec<RawItem>,
    #[serde(default)]
    pub decisions: Vec<RawItem>,
    #[serde(default, alias = "actionItems", alias = "action_items")]
    pub action_items: Vec<RawItem>,
    #[serde(flatten, default)]
    pub extra_sections: std::collections::BTreeMap<String, Vec<RawItem>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawItem {
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub rationale: Option<String>,
    #[serde(
        default,
        alias = "evidenceIds",
        alias = "evidence_ids",
        alias = "evidence_refs"
    )]
    pub evidence_ids: Vec<String>,
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub deadline: Option<String>,
}

/// Persistable, post-verification item.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthesisItemDraft {
    pub item_type: String,
    pub sort_order: i64,
    pub content: String,
    pub rationale: Option<String>,
    pub owner: Option<String>,
    pub deadline: Option<String>,
    pub is_completed: bool,
    pub is_user_edited: bool,
    pub evidence_refs: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedSynthesis {
    pub items: Vec<SynthesisItemDraft>,
    pub report: VerificationReport,
}

impl VerifiedSynthesis {
    pub fn summary(&self) -> Vec<&SynthesisItemDraft> {
        self.items
            .iter()
            .filter(|item| item.item_type == ITEM_SUMMARY)
            .collect()
    }

    pub fn decisions(&self) -> Vec<&SynthesisItemDraft> {
        self.items
            .iter()
            .filter(|item| item.item_type == ITEM_DECISION)
            .collect()
    }

    pub fn action_items(&self) -> Vec<&SynthesisItemDraft> {
        self.items
            .iter()
            .filter(|item| item.item_type == ITEM_ACTION)
            .collect()
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationReport {
    pub raw_items: usize,
    pub kept_items: usize,
    pub dropped_without_valid_evidence: usize,
    pub stripped_evidence_refs: usize,
    pub forced_unassigned_owners: usize,
    pub forced_unspecified_deadlines: usize,
}

impl VerificationReport {
    pub fn merge(&mut self, other: &Self) {
        self.raw_items += other.raw_items;
        self.kept_items += other.kept_items;
        self.dropped_without_valid_evidence += other.dropped_without_valid_evidence;
        self.stripped_evidence_refs += other.stripped_evidence_refs;
        self.forced_unassigned_owners += other.forced_unassigned_owners;
        self.forced_unspecified_deadlines += other.forced_unspecified_deadlines;
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthesisRequest {
    pub system: String,
    pub user: String,
    pub temperature: f32,
    pub top_p: f32,
    pub top_k: u32,
    pub max_output_tokens: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grammar: Option<String>,
}

impl Default for SynthesisRequest {
    fn default() -> Self {
        Self {
            system: String::new(),
            user: String::new(),
            temperature: 0.0,
            top_p: 1.0,
            top_k: 1,
            max_output_tokens: 2048,
            grammar: Some(JSON_OBJECT_GBNF.to_string()),
        }
    }
}
