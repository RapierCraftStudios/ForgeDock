# 5080: issue-dedup needs at least two shared tokens

`scripts/issue-dedup.sh` matched when the shared-token count reached 50% of the shorter title, so one shared generic noun on a short title was a duplicate. The match is now `shared >= 3` or (`shared >= 2` and `shared >= 50%` of the shorter title). One shared word never matches. Exit codes and `--exclude`/`--force` are unchanged.
