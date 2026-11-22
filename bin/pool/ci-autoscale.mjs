// #5695: demand- and capacity-driven CI runner autoscaler for the pool router. The decision logic (admitRunner, planScale,
// runnerPriority, decisionRecord) is pure; createAutoscaler wires it to the router's webhook, tick and agents.
// Imports stay inside bin/pool: the router ships agents only AGENT_BUNDLE_PATHS (pool-agent-bundle.test.mjs).

/** Priority classes, lowest number first: deploy > release-PR CI > lanes > ordinary PR CI. */
export const PRIORITY = { deploy: 0, release: 1, lane: 2, pr: 3 };
export const DEFAULT_FLOORS = { mem_available_gb: 3, load_per_cpu: 0.8, lane_cpus: 2, lane_mem_gb: 3, net_rx_mbps_max: null };
export const DEFAULT_SIZE = { cpus: 1, mem_gb: 2 };

const num = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : d);

/** Deploy labels and an explicit job.priority win; a release branch or job.release is release CI; the rest is PR CI. */
export function runnerPriority(job = {}) {
  if (Number.isInteger(job.priority) && job.priority >= 0 && job.priority <= PRIORITY.pr) return job.priority;
  if (/deploy/i.test(String(job.label ?? "")) || (job.labels ?? []).some((l) => /deploy/i.test(l))) return PRIORITY.deploy;
  if (job.release === true || /^(release|hotfix)[/-]/i.test(String(job.head_branch ?? ""))) return PRIORITY.release;
  return PRIORITY.pr;
}

/** One telemetry record per decision, carrying every input it was made from. */
export function decisionRecord({ action, label, job = null, admit = null, reason, inputs = {}, dry_run = false, at = null }) {
  return { at, action, label, job: job?.id ?? null, priority: job ? runnerPriority(job) : null, admit, reason, dry_run, inputs };
}

/**
 * Does one more runner fit? free = {mem_available_gb, load_per_cpu, vcpus, cpus_free, mem_free_gb}; reserved = what earlier
 * admissions of this round already took; net = {rx_mbps}. The lane floor keeps cpus_free/mem_free_gb for lanes at every
 * priority, so CI never blocks a lane beyond it.
 */
export function admitRunner({ free, floors = {}, reserved = {}, job = {}, net = null, size = null }) {
  const f = { ...DEFAULT_FLOORS, ...floors }, sz = size ?? job.size ?? DEFAULT_SIZE;
  const rc = num(reserved.cpus, 0), rm = num(reserved.mem_gb, 0), vcpus = Math.max(1, num(free.vcpus, 1));
  const after = {
    mem_available_gb: num(free.mem_available_gb, Infinity) - rm - sz.mem_gb,
    load_per_cpu: num(free.load_per_cpu, 0) + (rc + sz.cpus) / vcpus,
    cpus_free: num(free.cpus_free, Infinity) - rc - sz.cpus,
    mem_free_gb: num(free.mem_free_gb, Infinity) - rm - sz.mem_gb,
  };
  const inputs = { free, floors: f, reserved: { cpus: rc, mem_gb: rm }, size: sz, after, ...(net ? { net } : {}) };
  const no = (reason) => ({ admit: false, reason, inputs });
  if (after.mem_available_gb < f.mem_available_gb) return no(`MemAvailable ${after.mem_available_gb.toFixed(1)} GB after reservation < floor ${f.mem_available_gb}`);
  if (after.load_per_cpu > f.load_per_cpu) return no(`load ${after.load_per_cpu.toFixed(2)}/cpu after reservation > ${f.load_per_cpu}`);
  if (after.cpus_free < f.lane_cpus || after.mem_free_gb < f.lane_mem_gb) return no("lane floor: reservation would leave lanes less than the configured floor");
  const rx = num(net?.rx_mbps, null);
  if (f.net_rx_mbps_max && rx !== null && rx > f.net_rx_mbps_max && runnerPriority(job) > PRIORITY.deploy) return no(`network ${rx} MB/s > ${f.net_rx_mbps_max} (saturated)`);
  return { admit: true, reason: "fits", inputs };
}

const inWindow = (window, t) => (window ?? []).find((w) => Number(w.from) <= t && t < Number(w.to)) ?? null;

/**
 * Decide this round's runner starts and stops.
 * demand: {label: [job]} queued jobs; running: {label: {total, busy}}; labels: {label: {min, max, size}};
 * lanes: {waiting} (a waiting lane outranks ordinary PR CI); window: [{from,to}] maintenance windows in epoch ms.
 * Returns decision records; `start`/`stop` ones are actionable. Candidates are admitted in priority order.
 */
export function planScale({ demand = {}, running = {}, labels = {}, lanes = {}, window = [], free, floors = {}, net = null, now = 0, dry_run = false }) {
  const out = [], rec = (d) => out.push(decisionRecord({ at: now, dry_run, ...d }));
  const win = inWindow(window, now), cand = [];
  for (const [label, cfg] of Object.entries(labels)) {
    const queued = demand[label] ?? [], r = running[label] ?? { total: 0, busy: 0 };
    const min = num(cfg.min, 0), max = num(cfg.max, 0), size = cfg.size ?? DEFAULT_SIZE, idle = Math.max(0, r.total - r.busy);
    const ctx = { queued: queued.length, total: r.total, busy: r.busy, idle, min, max, size };
    const want = Math.min(Math.max(queued.length - idle, min - r.total, 0), Math.max(0, max - r.total));
    const jobs = [...queued].sort((a, b) => runnerPriority({ label, ...a }) - runnerPriority({ label, ...b }));
    for (let i = 0; i < want; i++) cand.push({ label, size, job: { label, ...(jobs[i] ?? { id: null }) }, ctx });
    const keep = Math.max(min, queued.length), surplus = Math.max(0, idle - Math.max(0, keep - r.busy));
    if (surplus > 0 && !win) rec({ action: "stop", label, admit: true, reason: `${surplus} idle runner(s) above max(min, queued)`, inputs: { ...ctx, surplus } });
    else if (want === 0) rec({ action: "hold", label, admit: null, reason: "no runner needed", inputs: ctx });
  }
  cand.sort((a, b) => runnerPriority(a.job) - runnerPriority(b.job));
  const reserved = { cpus: 0, mem_gb: 0 };
  for (const c of cand) {
    if (win) { rec({ action: "hold", label: c.label, job: c.job, admit: false, reason: `maintenance window${win.why ? `: ${win.why}` : ""}`, inputs: { ...c.ctx, window: win } }); continue; }
    if ((lanes.waiting ?? 0) > 0 && runnerPriority(c.job) > PRIORITY.lane) { rec({ action: "hold", label: c.label, job: c.job, admit: false, reason: "a lane is waiting and outranks ordinary PR CI", inputs: { ...c.ctx, lanes } }); continue; }
    const v = admitRunner({ free, floors, reserved, job: c.job, net, size: c.size });
    if (v.admit) { reserved.cpus += c.size.cpus; reserved.mem_gb += c.size.mem_gb; }
    rec({ action: v.admit ? "start" : "hold", label: c.label, job: c.job, admit: v.admit, reason: v.reason, inputs: { ...v.inputs, ...c.ctx } });
  }
  return out;
}

/**
 * Router-side controller. `ingest` takes a GitHub workflow_job payload (queued/in_progress/completed); `reconcile` (router
 * tick) polls the jobs API as a fallback, plans, and asks an agent to start or stop ephemeral JIT runners. Off by default;
 * dry_run logs every decision and starts nothing.
 */
export function createAutoscaler({ cfg = {}, now, log, capacities, agentCall, githubToken, fetchFn, agents }) {
  const c = cfg.ci_autoscale ?? {};
  const jobs = new Map(); // job id -> {id,label,status,runner,head_branch,at}
  const decisions = [];
  let lastPoll = -Infinity, seq = 0;
  const labelOf = (wj) => (wj?.labels ?? []).find((l) => Object.hasOwn(c.labels ?? {}, l)) ?? null;
  const track = (wj) => {
    const label = labelOf(wj);
    if (!label || !Number.isFinite(Number(wj.id))) return null;
    if (wj.status === "completed") { jobs.delete(Number(wj.id)); return { label, status: "completed" }; }
    const j = { id: Number(wj.id), label, labels: wj.labels, status: wj.status === "in_progress" ? "in_progress" : "queued", runner: wj.runner_name ?? null, head_branch: wj.head_branch ?? null, at: now() };
    jobs.set(j.id, j);
    return { label, status: j.status };
  };
  function ingest(body) {
    if (!c.enabled) return { enabled: false, tracked: false };
    const t = body?.workflow_job ? track(body.workflow_job) : null;
    return { enabled: true, tracked: Boolean(t), ...(t ?? {}) };
  }
  const gh = async (path, body) => {
    const r = await fetchFn(`https://api.github.com${path}`, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${await githubToken()}`, accept: "application/vnd.github+json", ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!r.ok) throw new Error(`GitHub ${path} -> ${r.status}`);
    return r.json();
  };
  async function poll() {
    if (!c.repo || now() - lastPoll < (c.poll_s ?? 300) * 1000) return;
    lastPoll = now();
    const seen = new Set();
    try {
      const runs = (await gh(`/repos/${c.repo}/actions/runs?status=queued&per_page=20`)).workflow_runs ?? [];
      for (const run of runs) for (const wj of (await gh(`/repos/${c.repo}/actions/runs/${run.id}/jobs?per_page=100`)).jobs ?? []) {
        if (wj.status === "queued" && labelOf(wj)) { seen.add(Number(wj.id)); if (!jobs.has(Number(wj.id))) track({ ...wj, head_branch: wj.head_branch ?? run.head_branch }); }
      }
      for (const [id, j] of jobs) if (j.status === "queued" && !seen.has(id) && now() - j.at > (c.poll_s ?? 300) * 1000) jobs.delete(id); // the API no longer lists it
    } catch (e) { log.warn?.(`ci-autoscale poll: ${e.message}`); }
  }
  const emit = (d) => { decisions.push(d); if (decisions.length > 200) decisions.shift(); log.info?.(`ci-autoscale ${JSON.stringify(d)}`); };

  async function reconcile() {
    if (!c.enabled) return [];
    for (const [id, j] of jobs) if (now() - j.at > 6 * 3600000) jobs.delete(id); // a lost completed event
    await poll();
    const caps = (await capacities()).filter((x) => x.ok && !x.paused);
    if (!caps.length) return [];
    const host = caps.sort((a, b) => (b.live?.mem_available_gb ?? 0) - (a.live?.mem_available_gb ?? 0))[0];
    const free = { mem_available_gb: host.live?.mem_available_gb, load_per_cpu: host.live?.load_per_core, vcpus: host.vm?.cpus ?? host.cpus_total, cpus_free: host.cpus_free, mem_free_gb: host.mem_free_gb };
    const demand = {}, running = {};
    for (const label of Object.keys(c.labels ?? {})) {
      demand[label] = [...jobs.values()].filter((j) => j.label === label && j.status === "queued");
      const mine = (host.runners ?? []).filter((r) => r.label === label), busyNames = new Set([...jobs.values()].filter((j) => j.status === "in_progress" && j.runner).map((j) => j.runner));
      running[label] = { total: mine.length, busy: mine.filter((r) => busyNames.has(r.name)).length, names: mine.map((r) => r.name).filter((n) => !busyNames.has(n)) };
    }
    const win = (c.windows ?? []).map((w) => ({ from: Date.parse(w.from), to: Date.parse(w.to), why: w.why }));
    const plan = planScale({ demand, running, labels: c.labels, lanes: { waiting: 0 }, window: win, free, floors: { ...c.floors, lane_cpus: c.lane_floor?.cpus ?? c.floors?.lane_cpus, lane_mem_gb: c.lane_floor?.mem_gb ?? c.floors?.lane_mem_gb }, net: host.net ?? null, now: now(), dry_run: Boolean(c.dry_run) });
    for (const d of plan) {
      emit(d);
      if (c.dry_run) continue;
      const a = agents()[host.name];
      try {
        if (d.action === "start") {
          const name = `ci-${d.label}-${now().toString(36)}-${seq++}`.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);
          const jit = await gh(`/repos/${c.repo}/actions/runners/generate-jitconfig`, { name, runner_group_id: c.runner_group_id ?? 1, labels: ["self-hosted", d.label], work_folder: "_work" });
          const r = await agentCall(a, "POST", "/runners", { name, label: d.label, jitconfig: jit.encoded_jit_config, cpus: d.inputs.size.cpus, mem_gb: d.inputs.size.mem_gb });
          if (!r.ok) log.warn?.(`ci-autoscale start ${name} on ${host.name}: HTTP ${r.status}`);
        } else if (d.action === "stop") {
          for (const n of running[d.label].names.slice(0, d.inputs.surplus)) await agentCall(a, "DELETE", `/runners/${encodeURIComponent(n)}`);
        }
      } catch (e) { log.warn?.(`ci-autoscale ${d.action} ${d.label}: ${e.message}`); }
    }
    return plan;
  }
  return { ingest, reconcile, decisions, jobs };
}
