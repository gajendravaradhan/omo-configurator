// W5.1 — doctor soft-check (bundle §2 fact 3 + §5 "Doctor as gate", soft in v1).
// Runs `bun x oh-my-opencode doctor --verbose --json`, parses the check results, and empirically
// verifies the `system-default` marker semantics (VERIFIED 2026-08-07: the marker is ABSENT when all
// slots carry explicit models — it signals an unconfigured slot falling back to the system default;
// schema validation is the primary gate, so a marker here is a WARNING, never a failure).
//
// Soft gate discipline: any doctor anomaly (check failure, marker present, or doctor itself failing
// to run) is recorded for the report — it never blocks the optimize flow (v1).

export interface DoctorCheckResult {
  name: string; status: string; message: string;
}

export interface DoctorSummary {
  ran: boolean;
  /** The Models check, when present. */
  modelsCheck: DoctorCheckResult | null;
  /** Empirically observed presence of the system-default marker in doctor output. */
  systemDefaultMarkerSeen: boolean;
  /** Human-readable notes for the report. */
  notes: string[];
}

interface RawDoctor {
  results?: Array<{ name?: unknown; status?: unknown; message?: unknown }>;
}

/** Run the doctor and return the parsed summary. Throws only on invocation failure (soft: callers warn). */
export async function runDoctor(): Promise<DoctorSummary> {
  let proc;
  try {
    proc = Bun.spawn([process.execPath, "x", "oh-my-opencode", "doctor", "--verbose", "--json"], {
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (e: unknown) {
    return { ran: false, modelsCheck: null, systemDefaultMarkerSeen: false, notes: [`doctor could not be started: ${(e as Error).message}`] };
  }
  const [exit, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  // Exit code is NOT a gate in v1 — the Models check content is what matters.

  let doc: RawDoctor | null = null;
  try {
    doc = JSON.parse(stdout) as RawDoctor;
  } catch {
    return { ran: false, modelsCheck: null, systemDefaultMarkerSeen: false, notes: [`doctor output was not JSON (exit ${exit}); stderr: ${stderr.slice(0, 500)}`] };
  }

  const results = (doc?.results ?? []).filter((r): r is { name: string; status: string; message: string } => typeof r.name === "string" && typeof r.status === "string" && typeof r.message === "string");
  const modelsCheck = results.find((r) => /^models$/i.test(r.name)) ?? null; const systemDefaultMarkerSeen = /system-default/i.test(stdout);

  const notes: string[] = [];
  if (modelsCheck) notes.push(`doctor Models check: ${modelsCheck.status} — ${modelsCheck.message}`);
  else notes.push("doctor output had no Models check");
  notes.push(systemDefaultMarkerSeen ? "doctor reported a system-default marker — at least one slot has no explicit model (soft: warning only)" : "doctor system-default marker: ABSENT (every slot carries an explicit model) — marker semantics VERIFIED 2026-08-07");
  const failures = results.filter((r) => r.status === "fail");
  if (failures.length) notes.push(`doctor non-Models failures (soft, non-blocking): ${failures.map((f) => `${f.name}=${f.status}`).join(", ")}`);

  return { ran: true, modelsCheck, systemDefaultMarkerSeen, notes };
}

/** Soft-gate helper: log doctor notes as warnings and return a report-ready summary string. */
export async function doctorSoftCheck(): Promise<DoctorSummary> {
  try {
    const summary = await runDoctor();
    for (const note of summary.notes) console.warn(`[doctor:soft] ${note}`);
    return summary;
  } catch (e: unknown) {
    // Never fail the optimize flow on a doctor anomaly — schema validation is the primary gate.
    console.warn(`[doctor:soft] doctor check unavailable: ${(e as Error).message}`);
    return { ran: false, modelsCheck: null, systemDefaultMarkerSeen: false, notes: [`doctor unavailable: ${(e as Error).message}`] };
  }
}
