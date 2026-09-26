# Changelog

All notable changes to Lumina Backend are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Versioning Policy

**Public API:** The GraphQL schema is the public interface. Changes to the schema follow semantic versioning:

- **Major (X.0.0):** Breaking changes to the schema (removed fields, renamed types, changed return types)
- **Minor (0.X.0):** New fields, new queries, new subscriptions (backward compatible)
- **Patch (0.0.X):** Bug fixes, performance improvements, internal changes (no schema changes)

Schema additions are backward compatible and do not require a major version bump — clients ignoring unknown fields continue to work.

Breaking changes are rare and advance the major version. Deprecation notices appear in the schema documentation for at least one minor release before removal.

## [Unreleased]

### Added
- API key authentication middleware: a key in the `x-api-key` header is resolved to a caller identity and attached to the GraphQL context. Anonymous access stays the default and is controlled by `ALLOW_ANONYMOUS_ACCESS`. Rejections are answered with 401 before a query is parsed, the key is never logged or echoed, and the stored hash is compared in constant time
- Resolver integration tests against real database (#122)
- Consumer-facing GraphQL API documentation (#121)
- Versioning policy and release workflow (#118)
- Strict TypeScript compiler options (#117)

### Changed
- Version is now reported in application startup logs

## How to Release

1. **Update versions** in `package.json` files:
   ```bash
   npm version patch|minor|major  # updates package.json version
   ```

2. **Update `CHANGELOG.md`:**
   - Move `[Unreleased]` changes under a new versioned section
   - Use the format: `## [X.Y.Z] - YYYY-MM-DD`

3. **Create a git tag:**
   ```bash
   git tag @lumina/graphql-server@X.Y.Z
   git tag @lumina/indexer@X.Y.Z
   git push origin @lumina/graphql-server@X.Y.Z @lumina/indexer@X.Y.Z
   ```

4. **Verify in CI** that the tagged release builds successfully.

The version reported in startup logs and available through the API matches the package version.

## Notes on this Changelog

This changelog documents changes visible to API consumers. Internal refactoring, test improvements, and dependency updates that do not affect the public interface are not listed unless they fix a bug.

Each release is tagged with both the GraphQL server version and indexer version. Both versions are kept in sync to simplify tracking.
