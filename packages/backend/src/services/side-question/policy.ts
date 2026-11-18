/**
 * AGENT-BTW-01: local/cloud routing for a side question (P9 "stays-local").
 *
 * The main chat turn already decides where a reply may run with
 * `providerIsLocal()` and `localModelOnly()`, and withholds "stays on this
 * computer" memory from a cloud reply. A side question must honour the same
 * rule, so this pure decision reuses those signals (passed in as booleans) and
 * never invents a policy:
 *
 *  1. When the local-only stage is active, the side question is forced to the
 *     local model and no API key is sent — whatever the snapshot used.
 *  2. The side channel's own history (recent Q&A + rolling summary) carries the
 *     locality it was produced under. A request whose provider locality differs
 *     from the stored history drops that history, so local-sourced content can
 *     never ride into a cloud request (and vice versa).
 */

export interface SideRoutingInput {
  /** `localModelOnly()` — the project's local-only stage. */
  localOnly: boolean;
  /** `providerIsLocal(snapshot.provider, snapshot.model)`. */
  snapshotProviderLocal: boolean;
  /** Whether the snapshot carries a paid-provider API key. */
  hasApiKey: boolean;
  /** Whether the side session already has stored history. */
  historyExists: boolean;
  /** Locality the stored history was produced under (null when none). */
  historyLocal: boolean | null;
}

export interface SideRoutingDecision {
  /** Is the effective request local? */
  providerLocal: boolean;
  /** Replace the snapshot's (cloud) provider with the local model. */
  forceLocalProvider: boolean;
  /** May the snapshot's API key be used for this request? */
  useApiKey: boolean;
  /** Clear the stored side history before running (locality changed). */
  dropHistory: boolean;
}

export function decideSideRouting(input: SideRoutingInput): SideRoutingDecision {
  // 1. Local-only forces local; otherwise follow the snapshot's provider.
  const providerLocal = input.localOnly ? true : input.snapshotProviderLocal;
  const forceLocalProvider = providerLocal && !input.snapshotProviderLocal;
  // A local request never sends an API key.
  const useApiKey = providerLocal ? false : input.hasApiKey;
  // 2. Drop history whenever its locality differs from this request's, so
  //    local-sourced Q&A/summary never reaches a cloud provider.
  const dropHistory = input.historyExists && input.historyLocal !== null && input.historyLocal !== providerLocal;
  return { providerLocal, forceLocalProvider, useApiKey, dropHistory };
}
