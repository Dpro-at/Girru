# Dpro account metadata service

This service is deployable source, not a deployed account authority. It uses the existing Google OIDC verifier and g1 signed-command implementation. No second relay, content registry, OAuth proxy or task executor is introduced. Node24 and the repository's existing TypeScript loader are required; no dependency installation is part of this change.

The account identity is Google's verified issuer and subject. Account creation, Google login and registry approval never assign a local application role, authorize an E2E peer key, copy an agent grant or execute a task. The desktop retains cloud credentials inside its existing OS-encrypted device vault and binds an approved session family to an explicitly verified local principal. Existing password, MFA, first-owner setup-code, SQL admission and approval policies remain in force.

## Stored metadata

The SQLite database retains canonical account identity; opaque account/device IDs; device public keys, owner-chosen names, broad OS/app version and approval/revocation state; hashed rotating session credentials and their security epochs; one-use challenge hashes; and bounded security events. Device freshness anchors contain only an opaque namespace hash, generation, sequence and membership hash. Presence is in RAM and expires after30seconds. No Google ID/access/refresh token, raw cloud credential, private key, configuration blob, agent memory, task/chat/report/file content or content-delivery queue is retained by this service. Local device history and outboxes remain on devices.

Challenge lifetime10minutes; access credential lifetime10minutes; session idle30days and absolute90days; security events30days; expired rows purged on the periodic retention pass; operational backups maximum7days. These are source policies, not evidence about an existing deployment's retention. See the deployment examples for proxy logging, body-spooling, backup and restore restrictions.

## Restore and ownership

The database uses one exclusive writer and a separately retained epoch/hash floor. Mismatch locks access. Explicit operator recovery invalidates every cloud credential and device approval. A live, PID-reused or unknown writer lease cannot be removed; explicit stopped-writer review requires a demonstrably nonexistent PID and preserves the old lease. Co-restoring both database and its independent epoch root cannot be detected by two restored files alone. Production requires the documented independent custody/backup/host-access policy or an accepted external epoch authority; this source does not attest a server's operational custody.

## Application continuity

Under one account, **Open my existing workspace** keeps the source's logical workspace ID and enables ongoing delivery of selected portable agents, personalities, specialties, Markdown skills, paused rules and supported interface preferences over the existing pinned encrypted peer channel. Source must be online, source selection/preview must still match, and incoming changes still require target-local review through existing services. Local resource IDs, models, projects and permissions are mapped locally. Definitions do not automatically assign relationships or grant tool/model access. **Start new workspace** creates an independent logical ID under that same account. Both may explicitly map task destinations and cooperate through the existing receiver-session/run admission.

Selected Board metadata and task-linked chat/report/artifact transfers retain their existing scoped contracts; they are not generic continuous full-history replication. Agent memory continuity remains unavailable until the paused protected-storage/deletion/restore contract is accepted. No raw profile, database or keychain copy is supported. The UI reports this category coverage instead of claiming complete memory or full-history continuity.

The relay protocol/server is unchanged. Deployment requires the new account process and its HTTPS path alongside the existing relay; no remote deployment or server changes have been performed. Google scopes are `openid` for device identity, and `openid email` for primary application signup/signin. No Gmail/Drive/API access or client secret is required. The public Desktop client identifier is configurable; consent app name is Dpro in the independently configured dpro-identity project.
