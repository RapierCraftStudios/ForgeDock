#!/usr/bin/env bash
. "$(dirname "$0")/../src/greet.sh"
[ "$(greet x)" = "hello x" ] || exit 1
