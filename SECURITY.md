# Security policy

## Reporting a vulnerability

Do not open a public issue for vulnerabilities, leaked private content or
credentials. Use GitHub's private vulnerability reporting for this repository.
Include affected versions, reproduction steps and potential privacy impact.

## Supported versions

Until the first stable release, security fixes target the latest `main` branch.

## Security boundaries

- Rangabot binds to `127.0.0.1` by default.
- Knowledge documents, embeddings, conversations and databases remain local and
  Git-ignored.
- Cloud handoff is disabled until an explicit preview and approval design exists.
- Model output is untrusted. Review code and consequential advice before use.

Run `npm run privacy:check`, `npm run check` and `npm audit --omit=dev` before a
release. If private material is committed, rotate affected credentials first,
then remove the material from the entire Git history—not only the latest commit.
