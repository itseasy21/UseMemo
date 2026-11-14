# Delivery summary

Branch: `feat/white-label-platform`
State: local-only branch, no remote configured, nothing pushed.

This document closes M7.6: the final documentation, commit-log audit, and branch summary.

## Delivered scope

| Milestone | Outcome |
| --- | --- |
| M0 | Branch, monorepo scaffold, commit plan, baseline |
| M1 | Host probe and reference report; upstream v0.4.1 harvested read-only; clean-room audio DSP crate |
| M2 | Brand manifest, secondary profile, assets, deterministic codegen, runtime allowlist |
| M3 | SQLite/FTS5 vault, grounded context, verifier, orchestrator, exporter, screenshot policy, model tiers |
| M4 | Tauri commands/events, capture scheduler, downloader, host test pass |
| M5 | LiteRT-LM worker source, stdio protocol, Rust client, CMake/Bazel scaffolds (native build blocked) |
| M6 | Five UI surfaces, typed event wiring, HUD window, Model Studio, typecheck and static export |
| M7 | Air-gap guard, hallucination acceptance, rebrand acceptance, screenshot/export acceptance, full gate, docs |

## Verification evidence

Final gate run on the recorded host:

```text
pnpm brand:check   Brand outputs are current for Use Memo.
pnpm test          11 brand + 5 air-gap + 25 audio + 8 bridge + 80 host + 1 acceptance
pnpm typecheck     clean
pnpm build         12 static pages exported
pnpm format:check  Rust + Prettier clean
cargo clippy ...   Finished with -D warnings
```

That is **130 automated checks** (16 TypeScript/Node, 114 Rust), plus the manual native and
browser fallback checklists in [acceptance.md](./acceptance.md).

## Commit audit

The branch contains the original foundation commits followed by the delivery sequence.
Every M4-M7 item added after the review has its own commit; early foundation commits group
tightly coupled milestones (for example, schema + verifier + orchestrator) because they
share the same migration and test surface.

Recent delivery commits:

```text
f1dfd66 style: apply rustfmt across the Rust workspace
234ecb5 fix(screenshot): expose scheduler session accessor for capture commands
149818c test: record passing Tauri check and unit suite (M4.6)
b6d4d05 feat(sidecar): add LiteRT-LM worker bridge and fail-closed engine selection
7e14f23 feat(ipc): add typed frontend host event hooks and command facade
5826efc feat(ui): add the vault shell, sidebar, dashboard, and command palette
113b18c feat(ui): add the synchronized three-pane meeting studio
0fa5e68 feat(ui): add the detached recording HUD route and window reveal
9158b5f feat(ui): add the synthesis bento canvas with bidirectional evidence focus
259864d feat(ui): add the LiteRT model manager and hardware studio
d887d24 test(security): enforce the air gap and remove source-level brand strings
dbdf06e fix(brand): generate HUD window permissions in the capability file
5ac4fad build(ui): record passing typecheck and production static export (M6.7)
7f54802 fix(tauri): wire the deep-link plugin declared by the brand config
b657980 chore(license): relicense the project under GPL-3.0-or-later
28e52d0 test: record the passing full suite, typecheck, build, and lint gate (M7.5)
0b77374 docs: add delivery, architecture, rebranding, offline, acceptance, and blocker guides
```

Audit checks:

- Working tree clean before the summary commit.
- `TODO.md` has no pending items; `M1.7` and `M5.4` remain explicitly blocked.
- `LICENSE` is GPL-3.0-or-later and matches `Cargo.toml`, both package manifests, the brand
  manifest, and `generated_brand.rs`.
- No `target/`, `out/`, `node_modules/`, or `.next/` content is tracked.
- No generated file is stale (`brand:check`).
- The deep-link plugin is initialized, so the generated `plugins.deep-link` config is not
  dangling.
- No remote is configured and no commit was pushed.

## Blocked work

Documented in [external-blockers.md](./external-blockers.md):

- M1.7 upstream baseline (unshipped `llama-helper`, build-time downloads, Bazel absent).
- M5.4 native LiteRT-LM worker compilation (Bazel + multi-GB upstream tree).
- Model weights and production digests (multi-GB, not vendored; catalog digests optional).
- Live audio capture/ASR adapters, cross-platform screenshot backends, OCR/diarization
  engines, and distribution signing.

## Reproduce

```bash
pnpm install
pnpm brand:check
pnpm test
pnpm typecheck
pnpm build
pnpm tauri:dev
```

For a rebrand, see [rebranding.md](./rebranding.md); for the offline guarantee, see
[offline-policy.md](./offline-policy.md).
