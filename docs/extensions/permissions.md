# Extension permissions and data

Use SDK APIs and existing owner/agent grants. Derive identity from the authenticated boundary; never trust a request body ID as authorisation. Owner/admin channel setup and inbound channel execution use different policies.

Routes need explicit access classification, ownership checks and bounded inputs. Keep secrets in the supported credential store and out of responses/logs. Installation, extension enablement, agent tool assignment and approval to execute are separate decisions.

Store migrations may create only the app's own allowed namespaced tables/indexes under the installer contract. Do not copy a bundled extension's broad historical migration into a downloadable package. State retention/removal behaviour; do not delete user data implicitly.

Test denied access, cross-owner isolation, disable/revoke, stale approvals and secret-safe errors. Relevant tests include `extensions-auth.test.mjs`, `extension-route-access.test.mjs` and `extension-resource-path.test.mjs` in `packages/backend/test/`.
