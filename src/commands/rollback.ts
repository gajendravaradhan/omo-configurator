import { PlutusError } from "../errors.ts";
export async function rollback(args: { list: boolean; to?: string; outputPath: string }): Promise<void> {
  void args;
  throw new PlutusError("rollback: not implemented (W4.5 task)");
}