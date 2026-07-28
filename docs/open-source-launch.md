# Open-source launch checklist

Repository visibility must not change until every blocking item is complete and
the owner explicitly approves publication.

## Completed foundation

- [x] Apache-2.0 code and documentation license
- [x] Interim branding and mascot policy
- [x] Contribution, conduct, security, support and maintainer guides
- [x] Pull-request and issue templates
- [x] CI for tests, lint, type checking, production build, privacy check and production audit
- [x] Guided and non-interactive setup paths
- [x] Public local-model registry with hardware and license guidance
- [x] Self-service Knowledge Vault initialization, ingestion, status, validation, backup and rollback
- [x] Current-tree privacy scanner for generated/private filenames, local user paths, common tokens and private keys

## Blocking before publication

- [ ] Decide the final license for Ranga artwork and whether contributors may use the Rangabot name on forks
- [x] Review historical Git objects for local user paths, common tokens, private keys and AWS access-key patterns
- [ ] Verify all bundled/public assets and starter sources have redistribution-compatible licenses
- [x] Rehearse dependency installation, tests, lint, type checking, build, privacy scan and production audit from a clean clone with no private runtime data
- [ ] Complete Linux CI and document Windows status accurately; macOS clean-clone rehearsal passes
- [ ] Replace repository-local personal project history with release-oriented documentation where appropriate
- [ ] Add screenshots or a short demo containing no personal conversations
- [ ] Configure protected `main`, required CI, private vulnerability reporting and Discussions
- [ ] Review the complete public diff and obtain explicit repository-owner approval

## Visibility change

Changing GitHub visibility is an external publication action. It is intentionally
not automated by Rangabot scripts or CI.
