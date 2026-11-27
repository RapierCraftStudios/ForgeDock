# Exit 127 under an interpreter is not a missing interpreter

`missingTool` (`bin/lean/conformance.mjs`) blamed an exit 127 with no "not found" line on the command's first word. For
`bash scripts/tests/<new>.sh` (a test the lane adds) that named `bash`, so lanes parked with "Remote sandbox lacks bash" even
though every sandbox has bash. When the first word is an interpreter (sh/bash/zsh, env, python, node, ruby, perl, bun, deno)
the 127 came from inside the script, so no tool is named; an explicit "command not found" line still names its tool.
