# Marketing integration handoff

Updated: 27 November 2026. This is a source-integration checkpoint, not an installer or production publishing release.

## Repository map

- [Girru](https://github.com/Dpro-at/Girru): native Marketing dashboard, encrypted connection capability, footer and My apps integration.
- [Girru Store](https://github.com/Dpro-at/girru-store): existing app `seo`, displayed as Marketing 1.2.2, OAuth and MCP bridge.
- [SEO Agent](https://github.com/9mtm/SEO-Ai-Agent): account/statistics backend and social MCP implementation. Access to this repository is private.

## Completed behavior

The same installed SEO app identity and existing records are preserved. Marketing displays websites, Search Console reports and keywords from the connected SEO Agent account. The Social tab embeds the npm `agent-connect-dpro@0.3.1` studio for editing, previews, local drafts and account selection. It has no sample records and excludes X. The header copy, external management link and local draft-service banner were removed at the owner's request.

Existing social account identities come from the OAuth-selected workspace on SEO Agent, through `list_social_accounts`, backed by its existing `listAccounts()` service. Platform credentials remain on SEO Agent. Marketing's own OAuth connection stays encrypted and isolated per Girru user. Renderer requests use the existing injected SessionClient transport with an exact owner-only Marketing route/tool allowlist, bounded response projection and credential-field removal; publishing cannot be requested through that dashboard contract. The installed app appears in the footer/customization menu and opens from My apps.

A selective read-only production rollout on SEO Agent advertises `read:social` and registers the account-listing tool. The actual workspace listing was verified in local Girru: 23 Facebook accounts, one Instagram account, one LinkedIn account, two YouTube channels and one TikTok account. This reads stored connection status; it does not establish fresh provider health or platform app approval.

## Deliberately inactive

- The editor has no publication, scheduling, provider connection-management or media-upload callbacks. Publish stays disabled. Account lifecycle controls in the embedded studio are unavailable; no existing platform account was disconnected or recreated.
- Local save/delete/undo requires Marketing 1.2.2's non-secret connection identifier. An older installed bridge disables saving. Draft content is local browser storage, scoped to Girru user and OAuth connection; it is not synchronized with SEO Agent posts.
- Broader SEO Agent social/YouTube MCP publication remains separate from the production read rollout. It requires reviewed migrations, explicit operator flags, OAuth `write:social`, workspace privileges, platform approvals and per-call approval. Do not enable it, apply migrations, upload content or deploy the entire branch as part of continuing this checkpoint.
- Google verification/quota and LinkedIn/TikTok platform approvals must be checked independently. A pending submission is not approval.

## Continuation boundaries

No post or video was created by this work. No new npm package, desktop installer or website release is implied by merging source. Original working checkouts contain unrelated changes and must not be reset or broadly staged. Check current branch, local changes, installed app version, granted scopes and runtime build before continuing. Never copy production databases or provider credentials into Git or change encryption keys for existing data.

The running SEO Agent server contains live-specific changes. Its read rollout was built from those sources rather than replacing them with the Git branch. Review a server/branch diff and preserve those changes before any later deployment. The full publishing migration remains unapplied.

## Validation at this checkpoint

- Girru: 1981 UI tests passed, two skipped; strict UI/backend type checks and production UI builds passed. Focused host credential/footer, extension-boundary, catalogue and dependency tests passed. The core UI production dependency audit reported no vulnerabilities.
- SEO Agent: 240 social tests passed, eight guarded database tests skipped; four actual registry adapter tests passed; isolated production build passed. Global TypeScript diagnostics outside this feature remain a known limitation.
- Store: manifest/index validation, Marketing OAuth/MCP mocks and existing HTML-parser compatibility checks passed. Check the repository's current Actions run for remote CI status.

All editing/publication checks used mocks. The separately verified live operation was reading existing account identities and reports, without publishing content or changing platform connections.
