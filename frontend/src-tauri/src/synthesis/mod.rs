pub mod context;
pub mod evidence;
pub mod orchestrator;
pub mod parse;
pub mod prompt;
pub mod types;
pub mod verifier;

pub use context::{build_context, SynthesisContext};
pub use evidence::{EvidenceIndex, EvidenceKind, EvidenceSource};
pub use orchestrator::{synthesize, SynthesisEngine};
pub use parse::parse_synthesis;
pub use types::*;
pub use verifier::verify;

pub mod sidecar;
