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
- [ ] Review every historical Git object with a dedicated secret scanner
- [ ] Verify all bundled/public assets and starter sources have redistribution-compatible licenses
- [ ] Rehearse setup, chat and Knowledge Vault ingestion from a fresh clone with no existing `.env.local`, database or index
- [ ] Test at least macOS and Linux; document Windows status accurately
- [ ] Replace repository-local personal project history with release-oriented documentation where appropriate
- [ ] Add screenshots or a short demo containing no personal conversations
- [ ] Configure protected `main`, required CI, private vulnerability reporting and Discussions
- [ ] Review the complete public diff and obtain explicit repository-owner approval

## Visibility change

Changing GitHub visibility is an external publication action. It is intentionally
not automated by Rangabot scripts or CI.
