#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5197: the one routing source for scripts/file-deferred-followups.sh. Usage: followup-route.mjs owner|host <why>
// prints post-deploy | host | external, as decided by ownerRoute / hostRoute in bin/lean/conformance.mjs.
import { ownerRoute, hostRoute } from "../bin/lean/conformance.mjs";

const [kind, why = ""] = process.argv.slice(2);
if (kind === "owner") console.log(ownerRoute({ bucket: "owner:x", why }));
else if (kind === "host") console.log(hostRoute({ bucket: "host", why }));
else { console.error("usage: followup-route.mjs owner|host <why>"); process.exit(2); }
