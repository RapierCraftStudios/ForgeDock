// Known failure signatures for FORGE:LANE_AUDIT (#6076, seeded from the failure classes of #6072).
// {id, class: genuine|pipeline|spec|env|pool, owner, action, match(evidence) -> boolean, introduced_in, fixed_in}
// `evidence.text` is the lower-noise concatenation of detail, park rows, stderr and run-log tail. introduced_in / fixed_in are engine
// versions (null = unknown / not fixed yet); a lane on an engine older than fixed_in is classified fixed_in_later, not active.
const t = (e) => String(e?.text ?? "");
const re = (r) => (e) => r.test(t(e));
const sig = (id, klass, owner, action, match, extra = {}) => ({ id, class: klass, owner, action, match, introduced_in: null, fixed_in: null, ...extra });

export const SIGNATURES = [
  sig("gh-network-text", "pipeline", "#6068", "treat a gh network error text as transient and retry, not as a blocker",
    re(/error connecting to api\.github\.com|could not resolve host:? ?(api\.)?github\.com|dial tcp .*github|tls handshake timeout.*github|econnreset.*github/i)),
  sig("unguarded-status-post", "pipeline", "#6045", "guard the status post so a failed comment cannot kill the lane",
    re(/status (post|comment|edit) (failed|threw)|unguarded status post|writeStatus.*(failed|threw)/i)),
  sig("no-status-rows", "pipeline", "#6058", "write the status rows before the terminal so the park cites them",
    (e) => /no[- ]status rows|status rows? (missing|absent)/i.test(t(e)) || (e?.parkRows?.length === 0 && e?.reason === "needs-human" && /parked/i.test(t(e)))),
  sig("contract-deferred-judged-omission", "pipeline", "#6051", "a narrowing backed by a cited frozen decision is not an omission",
    re(/omission[\s\S]{0,200}(defer(red)?|narrow(ed|ing)?)[\s\S]{0,200}(contract|decision)|(defer(red)?|narrow(ed|ing)?)[\s\S]{0,120}(contract|decision)[\s\S]{0,200}omission/i)),
  sig("decision-not-reaching-reviewer", "pipeline", "#6051", "carry the free-text decision to the reviewer",
    re(/free[- ]text decision[\s\S]{0,80}(not|never)[\s\S]{0,40}(reach|seen|passed)[\s\S]{0,40}review/i)),
  sig("amendment-syntax", "pipeline", "#6018", "fix the amendment shape (typed kind, one requirement id per row)",
    re(/unknown amendment kind|amendment[s]? (rejected|invalid|malformed)|amendment .*not a (typed|valid)/i)),
  sig("remote-sandbox-tool-gap", "env", "#6017", "the remote sandbox lacks a tool the lane needs; provision it in the image",
    re(/(command not found|not found in (the )?(remote )?sandbox|enoent).*(sandbox|remote)|remote sandbox.*(missing|lacks|without).*(tool|binary)/i)),
  sig("mirror-seed-conflict", "pool", "#6065", "reseed the mirror once; a 409/422 on seed is not a lane failure",
    re(/mirror[\s\S]{0,80}seed[\s\S]{0,120}\b(409|422)\b|\b(409|422)\b[\s\S]{0,80}mirror[\s\S]{0,40}seed/i)),
  sig("genuine-credentials", "genuine", "human", "a human provides the credential", re(/\b(credentials?|api[- ]key|secret|token) (is |are )?(needed|required|missing)|need creds|needs? credentials/i)),
  sig("genuine-spend", "genuine", "human", "a human approves the spend", re(/approv(e|al)( of)? (the )?(spend|budget|purchase|payment)|paid (plan|account) (is )?required|billing/i)),
  sig("genuine-product-decision", "genuine", "human", "the owner makes the product decision", re(/product decision|which (behaviou?r|option) (do you|should)|owner (must|should) (choose|decide)/i)),
  sig("genuine-customer", "genuine", "human", "a human contacts or answers the customer", re(/customer (data|input|confirmation|must)|ask the customer|waiting for (the )?customer/i)),
  sig("genuine-prod-access", "genuine", "human", "a human with production access acts", re(/production access|prod(uction)? (credentials|database|console) (is |are )?(needed|required)|requires? access to prod/i)),
  sig("spec-two-features", "spec", "author", "split the issue: it asks for two features",
    re(/two (separate |independent |distinct )?features|bundles? (two|2) (features|changes)|split (this|the) issue/i)),
];
