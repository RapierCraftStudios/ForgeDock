# 6031: a reopened issue's own failed fix stays recurrence evidence

`recurrenceFacts` (bin/lean/recurrence.mjs) drops PRs merged after the issue's `createdAt` (#6016). That also dropped the earlier fix of a reopened issue.

Now the pulls read also fetches the PR body. A post-creation merge is kept as evidence when its body closes/fixes/resolves this issue (`Closes #N`, optionally `owner/repo#N`). Release-head PRs stay excluded even if they close the issue; unrelated siblings and PRs closing other issues stay excluded. Chose a body regex over a linked-issue API call to avoid an extra read per row.
