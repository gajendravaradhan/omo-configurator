// omo-plutus — PlutusError with a fixed exit code.
// Exit codes per bundle §1.11: 0=ok, 1=runtime error, 2=validation failure, 3=spike-unresolved/version-mismatch.
import { EXIT, type ExitCode } from "./types.ts";

export class PlutusError extends Error {
  readonly exitCode: ExitCode;

  constructor(message: string, exitCode: ExitCode = EXIT.RUNTIME) {
    super(message);
    this.name = "PlutusError";
    this.exitCode = exitCode;
  }
}

/** Convenience for throw sites. */
export function plutusError(message: string, exitCode: ExitCode = EXIT.RUNTIME): PlutusError {
  return new PlutusError(message, exitCode);
}