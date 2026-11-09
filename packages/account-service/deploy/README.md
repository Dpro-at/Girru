# Preparing the Dpro metadata service on an existing relay host

These are source templates, not a deployed service. Deployment requires a
separate approval and an inventory of the current server. They do not replace
the existing phone relay or authorize a Girru application release.

## Process and storage boundary

Keep the existing `/v1` WebSocket relay unchanged. Run this package as a separate
unprivileged process on a reviewed, unused loopback port. Mount `/identity/v1/`
under the existing TLS host without removing the prefix. The service checks the
canonical public Host and refuses a public listener. The example uses
`relay.girru.net`; confirm that actual host and proxy before using it.

The database holds account identity, device public keys, session hashes,
revocation and bounded security metadata. It is not a work-content store.
Tasks, files, memories, configuration blobs, private keys and Google tokens must
not appear in its database, backups, request logs or error reporting.

The independent epoch root is a security dependency. A different directory is
not enough if the operator restores both directories from the same old snapshot.
Keep its retention and restore operations independent from the metadata database.
If independent freshness cannot be established, refuse activation and use the
explicit metadata-recovery procedure. Never delete an epoch root to make an old
database start. Recovery invalidates sessions and may require device enrollment;
it does not recover work-content keys.

## Preparation after deployment approval

1. Record the actual proxy, relay version, Node executable, listener allocations,
   service users, backup boundaries and current phone behavior. Do not copy real
   application profiles into a deployment fixture.
2. Prepare a reviewed source/dependency tree at an operator-selected read-only
   location. This package currently needs Node 24 or later, the existing `tsx`
   loader and the shared source imports included in the reviewed tree. Copying
   this package alone is insufficient. No dependency installation, application
   packaging or CI run is performed by these templates.
3. Optional: account two-step sign-in. Create a private key file for the
   `dpro-account` user (mode 0600, inside a 0700 directory) holding 32 random
   bytes as base64url, keep an offline copy, and add
   `--secret-key-file /var/lib/dpro-account-keys/totp.key` to `ExecStart`. It
   seals each account's authenticator secret. Without it, two-step sign-in stays
   off and computers are added only with a Yes on another computer. Losing the
   file turns off two-step for every account; never commit or print it.
   Existing stores gain the new columns in place on the next start.
3. Review `service.env.example`. Match the canonical origin, port and epoch root
   to the approved inventory. Provision the metadata and independently retained
   epoch directories as private directories for `dpro-account`. This service
   user must not be able to read user workspaces or other service credentials.
4. Initialize a genuinely new metadata store once with the explicit CLI
   `--initialize-new-store` and `--confirm-independent-epoch` options, using the
   same user, paths, origin and client ID as the eventual service. That command
   starts the service; stop it gracefully after initialization. Never put the
   initialization flag in a restart policy, and never initialize over an
   existing database/epoch pair.
   A stopped-writer lease is a separate recovery case: the explicit CLI option
   is `--recover-stopped-writer 'REVIEW STOPPED ACCOUNT WRITER'`. It only permits
   recovery after the process is proven absent twice and the owner record stays
   unchanged, preserving the previous lease directory. A live, reused or unknown
   process refuses recovery. Review the exact host process and paths first;
   never add this option to the service unit or automate a retry.
5. Adapt `dpro-account.service.example`: Node path, source directory and both
   writable roots must match the approved host. The environment file contains
   public configuration, not credentials. The service runs without initialization
   or automatic recovery flags. Do not enable it until the reviewed deployment
   and rollback plan are approved.
6. For nginx, merge only the example location into the existing TLS server.
   Preserve the relay WebSocket route. If the host uses another proxy, translate
   the same path/Host/body-limit/no-retry/no-content-logging behavior rather than
   replacing the proxy. Disable inherited debug logging, tracing, body capture,
   error-page dumps and request-body disk buffering for this route. The service
   does not trust forwarded network addresses for authority.

The example port and filesystem paths are proposed values, not discovered facts
about the production server. The service still needs outbound HTTPS for Google's
public verification keys. It stores no Google access or refresh token and needs
no desktop OAuth client secret.

## Acceptance and rollback

Before public exposure, complete the approved synthetic service/app round and
record exact source revision and protocol compatibility. Separately verify the
actual proxy's Host handling, TLS, bounded bodies, no content logging and no disk
spooling. A successful `/identity/v1/health` response alone does not prove account
isolation, enrollment or device execution.

For an approved rollout, compare existing phone behavior before and after adding
the metadata route. Identity service failure must not stop the existing relay,
grant a local owner role or bypass a device's approval policy. Revoke and delete
operations must be exercised with synthetic accounts before real enrollment.

Roll back the service source only when the previous version understands the
current schema and security epochs. Do not restore an older metadata database or
epoch root as a routine application rollback. If incompatible, stop the identity
route and preserve the database/epoch state for explicit recovery. Never log
tokens or dump account rows to diagnose a rollback.

## Retention

The source policy exposes current lifetimes at `/identity/v1/policy`. Initial
defaults are ten-minute challenges/access tokens, thirty-day session inactivity,
ninety-day absolute session lifetime and thirty-day bounded security events.
Presence is transient; no task progress history is stored on the service.

Encrypted metadata backups are an operator responsibility, with a proposed
maximum seven-day lifetime. Service code cannot enforce retention of external
snapshots, journals, proxy logs or monitoring exports. Record their configuration
and deletion behavior before making a production privacy claim. Independent
epoch retention must not be weakened to match the database backup rotation.

## Desktop configuration and physical-device acceptance

A successful Google sign-in on one computer does not establish a reachable
central account service. Configure the desktop's reviewed account origin to the
same canonical `/identity/v1` origin deployed above. The current development
entry point accepts `GIRRU_ACCOUNT_ORIGIN`; the Devices account configuration
must match that origin. Never put an OAuth client secret in that environment.

The native Desktop OAuth client exchanges its code directly with Google using
PKCE. Its installed-client configuration is imported through a native file
picker and kept in OS-protected custody. The account service verifies the
resulting identity proof with Google's public keys; do not upload that Desktop
configuration to this service. The current operator import is suitable for a
controlled trial, not a finished ordinary-user release setup. Release credential
provisioning remains a separate decision. Google Testing audience/test-user
restrictions must also be checked before inviting another tester.

After the separately approved deployment, use temporary app profiles on both
physical computers, with independent native key stores:

1. Confirm the existing phone relay still connects before and after the proxy
   change. Confirm the account origin is reachable through TLS and that proxy
   logging/tracing never records bodies, authorization headers or identity proofs.
2. Sign in on the first computer, then sign in to the same Dpro identity on the
   second. Compare public device identities and approve the pending device.
   Google sign-in alone must not grant task execution or file access.
3. Test both choices: an independent new workspace and explicitly joining the
   same logical workspace. Review selected settings at both ends. Do not enable
   memory continuity or claim a full historical account clone.
4. Send a synthetic task. Verify one pending Board card appears on the target;
   refusal runs nothing, approval admits once, and scheduling obeys the target's
   time window. Confirm the visible task/run names the executing computer.
5. Enable approved direct LAN transport, then interrupt only that test transport.
   Verify encrypted relay fallback, no duplicate admission and no silent grant
   expansion. With the source offline, selected-content transfer waits.
6. Restart both temporary profiles; verify stable public keys and fresh sessions.
   Revoke one device and confirm cached state cannot admit another task. Exercise
   restore invalidation only with a separate disposable metadata/epoch pair.
7. Record actual macOS Keychain and Windows DPAPI results separately. A macOS
   result or a mocked Windows fixture does not accept the Windows installation.

Rollback must preserve the reviewed metadata and independent epoch boundary.
Stop the new service and remove only its new proxy route if deployment fails;
do not reset the existing relay, restore both roots from an old snapshot, or
change application versions to mask a protocol mismatch. Do not retry CI or
initialization/recovery automatically.

## Apache/cPanel host preparation

The currently inventoried relay host uses Apache with a dedicated Girru virtual
host, rather than nginx. Its relay has a separate Node 20 executable and listens
on loopback41540. Do not replace that executable or transplant the nginx example.
The proposed account port41541 was not listening during inventory; reserve and
recheck it at deployment time.

The existing TLS virtual host has a catch-all404 rewrite before the health proxy.
A reviewed Apache change must route `/identity/v1/` before that catch-all (or
explicitly exclude that prefix from the catch-all), preserve the full prefix and
public Host, impose the service's bounded request limit, and retain the existing
WebSocket `/v1` and `/health` rules. Merely adding ProxyPass after the404 rule will
not expose the account service. Check inherited access/error/body tracing and
request buffering at the actual virtual-host boundary. Syntax validation and
phone/relay regression must precede any reload. No Apache patch has been applied.

The default Node on this host is18 and an existing cPanel Node20 is present.
Account service needs a separately approved Node24 runtime; do not upgrade the
relay or system default as a side effect. The general cPanel backup configuration
was disabled during inventory. It is not evidence of any independently managed
backup policy. Before deployment, explicitly provision and verify private metadata
backups and independent epoch retention; neither directory exists yet at the
proposed service paths. Do not enable global server backups or restore unrelated
services as part of this account-service task.
